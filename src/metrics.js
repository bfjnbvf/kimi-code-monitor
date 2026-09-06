'use strict';

const MIN_SPEED_DURATION_MS = 100;

function toNonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function firstDefined(source, keys) {
  for (const key of keys) {
    if (source?.[key] != null) return source[key];
  }
  return 0;
}

function normalizeUsage(raw) {
  const usage = raw && typeof raw === 'object' ? raw : {};
  return {
    inputTokens: toNonNegativeInteger(firstDefined(usage, [
      'inputOther', 'input_tokens', 'prompt_tokens'
    ])),
    outputTokens: toNonNegativeInteger(firstDefined(usage, [
      'output', 'output_tokens', 'completion_tokens'
    ])),
    cacheReadTokens: toNonNegativeInteger(firstDefined(usage, [
      'inputCacheRead', 'cache_read_input_tokens', 'cache_read_tokens'
    ])),
    cacheCreationTokens: toNonNegativeInteger(firstDefined(usage, [
      'inputCacheCreation', 'cache_creation_input_tokens', 'cache_creation_tokens'
    ]))
  };
}

function totalInputTokens(usage) {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
}

function cacheReadPercentage(usage) {
  const total = totalInputTokens(usage);
  return total > 0 ? (usage.cacheReadTokens / total) * 100 : null;
}

// 百分比统一显示一位小数，向下截断而非四舍五入：使用率类指标宁少算不多算，
// 99.95% 显示 99.9%，不会提前跳到 100.0%。显示上限仍为 100（超用不展示真实比例）。
function formatPercentage(value, decimals = 1) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const places = Math.max(0, Math.min(6, Math.floor(Number(decimals) || 0)));
  const factor = 10 ** places;
  const clamped = Math.max(0, Math.min(100, number));
  // 末位加 1e-6 仅抵消二进制浮点误差（如 79.999…→80），不会把真实末位进上去
  const truncated = Math.floor(clamped * factor + 1e-6) / factor;
  return truncated.toFixed(places);
}

/* ---------- 按天消耗量累计（popup 消耗量板块数据源） ---------- */

// 本地自然日的 'YYYY-MM-DD'，字典序即时间序，可直接字符串比较。
// 用本地时区而非 UTC：「今日消耗」以用户本地午夜为界，东八区清晨的用量不再算进昨天。
function usageDayKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// 本地小时键 'YYYY-MM-DDTHH'：24h 图表按小时分柱；字典序即时间序
function usageHourKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return `${usageDayKey(d)}T${String(d.getHours()).padStart(2, '0')}`;
}

// 小时桶只保留最近 keepDays 个自然日（含今天），避免长期膨胀
function pruneHourlyUsage(hourly, keepDays = 2, now = new Date()) {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - (keepDays - 1));
  const cutoffKey = `${usageDayKey(cutoff)}T00`;
  const next = {};
  for (const [key, bucket] of Object.entries(hourly || {})) {
    if (key >= cutoffKey) next[key] = bucket;
  }
  return next;
}

// 只保留最近 keepDays 个自然日（含今天）的桶，防止存储无限膨胀
function pruneDailyUsage(daily, keepDays = 90, now = new Date()) {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - (keepDays - 1));
  const cutoffKey = usageDayKey(cutoff);
  const next = {};
  for (const [key, bucket] of Object.entries(daily || {})) {
    if (key >= cutoffKey) next[key] = bucket;
  }
  return next;
}

// 任意日期范围求和（含端点）；startKey/endKey 传 null 表示不限
function sumUsageBetween(daily, startKey, endKey) {
  const total = { input: 0, output: 0, cacheRead: 0 };
  for (const [key, bucket] of Object.entries(daily || {})) {
    if (startKey && key < startKey) continue;
    if (endKey && key > endKey) continue;
    total.input += toNonNegativeInteger(bucket?.input);
    total.output += toNonNegativeInteger(bucket?.output);
    total.cacheRead += toNonNegativeInteger(bucket?.cacheRead);
  }
  total.totalTokens = total.input + total.output;
  total.cacheHitRate = total.input > 0 ? total.cacheRead / total.input : null;
  return total;
}

// 枚举范围内的每个本地日 key（含端点），无记录的日期也会列出，供图表补零
function listDayKeysBetween(startKey, endKey) {
  const parse = (key) => {
    const [y, m, d] = String(key).split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
  };
  const keys = [];
  const end = parse(endKey);
  for (let d = parse(startKey); d <= end; d.setDate(d.getDate() + 1)) {
    keys.push(usageDayKey(d));
  }
  return keys;
}

// 活跃热力图数据：固定窗口（默认最近 90 天，含 endKey 当天），按周一起头分列。
// 只依赖按天桶的 input/output，旧格式桶缺失字段按 0 处理。
function buildHeatmapData(daily, endKey, dayCount = 90) {
  const source = daily && typeof daily === 'object' ? daily : {};
  const count = Math.max(1, Math.floor(Number(dayCount)) || 90);
  const [y, m, d] = String(endKey).split('-').map(Number);
  const end = new Date(y, (m || 1) - 1, d || 1);
  const cells = [];
  let maxTotal = 0;
  for (let i = count - 1; i >= 0; i -= 1) {
    const date = new Date(end);
    date.setDate(date.getDate() - i);
    const key = usageDayKey(date);
    const bucket = source[key];
    const total = toNonNegativeInteger(bucket?.input) + toNonNegativeInteger(bucket?.output);
    if (total > maxTotal) maxTotal = total;
    // getDay()：0=周日 … 6=周六；换算成周一起头的列内序号（周一=0）
    cells.push({ key, total, weekIndex: (date.getDay() + 6) % 7 });
  }
  const thresholds = maxTotal > 0
    ? [0.2, 0.4, 0.6, 0.8].map((fraction) => maxTotal * fraction)
    : [0, 0, 0, 0];
  const levelOf = (total) => {
    if (total <= 0 || maxTotal <= 0) return 0;
    if (total <= thresholds[0]) return 1;
    if (total <= thresholds[1]) return 2;
    if (total <= thresholds[2]) return 3;
    return 4;
  };
  const weeks = [];
  for (const cell of cells) {
    // 周一（或首格）开新列；首尾列因窗口边界自然截断，不足 7 格
    if (weeks.length === 0 || cell.weekIndex === 0) weeks.push([]);
    weeks[weeks.length - 1].push({ key: cell.key, total: cell.total, level: levelOf(cell.total) });
  }
  return { weeks, maxTotal, thresholds };
}

// 与 widget 的 fmtNum 同款缩写：k / M
function formatTokenCount(value) {
  const number = toNonNegativeInteger(value);
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(number);
}

function decodeSpeed(outputTokens, durationMs) {
  const output = toNonNegativeInteger(outputTokens);
  const duration = Number(durationMs);
  if (!Number.isFinite(duration) || duration < MIN_SPEED_DURATION_MS || output === 0) return null;
  return Math.round(output / (duration / 1_000));
}

// 面板速度大数字：最近若干步的聚合速度（总输出 ÷ 总流式时长）。
// 单步时长过短的离群点（缓存秒回/高速模型）不会把显示值顶到不可能的高度
function aggregateSpeed(samples, maxSamples = 10, minDurationMs = MIN_SPEED_DURATION_MS) {
  let totalOut = 0;
  let totalMs = 0;
  let counted = 0;
  for (let i = samples.length - 1; i >= 0 && counted < maxSamples; i -= 1) {
    const sample = samples[i];
    const ms = Number(sample?.outMs);
    const output = Number(sample?.output);
    if (Number.isFinite(ms) && ms >= minDurationMs && Number.isFinite(output) && output > 0) {
      totalOut += output;
      totalMs += ms;
      counted += 1;
    }
  }
  return totalMs > 0 ? Math.round(totalOut / (totalMs / 1_000)) : 0;
}

function boosterBalanceYuan(wallet) {
  if (!wallet || typeof wallet !== 'object') return null;
  const status = String(wallet?.status || '').toUpperCase();
  if (status !== 'STATUS_ACTIVE' && status !== 'STATUS_ENABLED') return 0;
  const amountLeft = Number(wallet?.balance?.amountLeft);
  return Number.isFinite(amountLeft) ? Math.max(0, amountLeft / 100_000_000) : null;
}

/* ---------- Widget 模块配置（左下面板模块化） ---------- */

// 模块 id 即排序默认值；header 是标题行（固定整宽，高度与其他模块不同）
// 注：quotaMonth（本月额度）暂时下线——web token 方案不理想，找到更干净的通路前隐藏
const WIDGET_MODULE_IDS = [
  'header', 'input', 'cache', 'output', 'speed', 'duration',
  'quota5h', 'quotaWeek', 'usageChart', 'pet', 'agents', 'external'
];
const WIDGET_SHOW_STATES = ['full', 'mini', 'hidden'];
const CHART_RANGES = ['day', 'week', 'month'];
const PET_STATS = ['daily', 'input', 'output', 'cache', 'speed', 'balance'];
const BALL_LINKS = ['none', 'console', 'subscription'];
const BALANCE_LINKS = ['subscription', 'console'];
// 额度重置时间：countdown 倒计时（3d5h）/ absolute 具体时间（08-05 15:00）
const QUOTA_RESET_FORMATS = ['countdown', 'absolute'];

function defaultWidgetConfig() {
  return {
    version: 3,
    modules: {
      header: { show: 'hidden', span: 2, showBalance: true, balanceLink: 'subscription' },
      input: { show: 'full', span: 1 },
      cache: { show: 'full', span: 1 },
      output: { show: 'full', span: 1 },
      speed: { show: 'full', span: 1 },
      duration: { show: 'hidden', span: 1 },
      quota5h: { show: 'mini', span: 1, pace: true, resetFormat: 'countdown' },
      quotaWeek: { show: 'mini', span: 1, pace: true, resetFormat: 'countdown' },
      usageChart: { show: 'full', span: 2, chartRange: 'week' },
      pet: { show: 'mini', span: 2, stat: 'daily', sidebarTidy: true, ballLink: 'none' },
      agents: { show: 'hidden', span: 2, hiddenAgents: [] },
      external: { show: 'hidden', span: 1, hiddenAccounts: [] }
    },
    orderFull: ['input', 'cache', 'output', 'speed', 'usageChart'],
    orderMini: ['pet', 'quota5h', 'quotaWeek'],
    orderHidden: ['header', 'duration', 'external', 'agents']
  };
}

// 任意来源（chrome.storage、旧版本、手动改坏的 JSON）都归一化成合法配置：
// 非法字段回落默认值，order 数组与模块显隐状态强制一致（mini 沉底、hidden 入隐藏区）
function normalizeWidgetConfig(raw) {
  const defaults = defaultWidgetConfig();
  const source = raw && typeof raw === 'object' ? raw : {};
  const rawModules = source.modules && typeof source.modules === 'object' ? { ...source.modules } : {};

  // v1 结构迁移：标题行曾是独立的 header 配置 → 并入 modules.header
  const legacy = source.header && typeof source.header === 'object' ? source.header : null;
  if (legacy && !rawModules.header) {
    rawModules.header = {
      show: legacy.showInMini === true ? 'mini' : legacy.showInMini === false ? 'full' : undefined,
      showBalance: legacy.showBalance,
      balanceLink: legacy.balanceLink
    };
  }
  // v2 → v3：宠物默认从半宽改为全宽（仅迁移一次，之后的手动调整不受影响）
  if ((!Number.isFinite(Number(source.version)) || Number(source.version) < 3) && rawModules.pet) {
    rawModules.pet = { ...rawModules.pet, span: 2 };
  }

  const modules = {};
  for (const id of WIDGET_MODULE_IDS) {
    const fallback = defaults.modules[id];
    const entry = rawModules[id] && typeof rawModules[id] === 'object' ? rawModules[id] : {};
    const normalized = {
      show: WIDGET_SHOW_STATES.includes(entry.show) ? entry.show : fallback.show,
      span: entry.span === 2 ? 2 : 1
    };
    // 缺省时回落该模块的默认宽度（整宽模块不被误压成半宽）
    if (entry.span == null) normalized.span = fallback.span;
    if (id === 'header') {
      normalized.span = 2;
      normalized.showBalance = typeof entry.showBalance === 'boolean'
        ? entry.showBalance
        : fallback.showBalance;
      normalized.balanceLink = BALANCE_LINKS.includes(entry.balanceLink)
        ? entry.balanceLink
        : fallback.balanceLink;
    }
    if (id === 'usageChart') {
      normalized.chartRange = CHART_RANGES.includes(entry.chartRange)
        ? entry.chartRange
        : fallback.chartRange;
    }
    if (id === 'pet') {
      normalized.stat = PET_STATS.includes(entry.stat) ? entry.stat : fallback.stat;
      normalized.sidebarTidy = typeof entry.sidebarTidy === 'boolean'
        ? entry.sidebarTidy
        : fallback.sidebarTidy;
      normalized.ballLink = BALL_LINKS.includes(entry.ballLink) ? entry.ballLink : fallback.ballLink;
    }
    if (id.startsWith('quota')) {
      normalized.pace = typeof entry.pace === 'boolean' ? entry.pace : fallback.pace;
      normalized.resetFormat = QUOTA_RESET_FORMATS.includes(entry.resetFormat)
        ? entry.resetFormat
        : fallback.resetFormat;
    }
    if (id === 'agents') {
      // 子代理列表需要多行高度，只允许整宽
      normalized.span = 2;
      normalized.hiddenAgents = Array.isArray(entry.hiddenAgents)
        ? entry.hiddenAgents.filter((v) => typeof v === 'string')
        : [];
    }
    if (id === 'external') {
      normalized.hiddenAccounts = Array.isArray(entry.hiddenAccounts)
        ? entry.hiddenAccounts.filter((v) => typeof v === 'string')
        : [];
    }
    modules[id] = normalized;
  }

  const reconcile = (order, region, regionDefaults) => {
    const wanted = WIDGET_MODULE_IDS.filter((id) => modules[id].show === region);
    // 手动改坏 storage 可能留下重复 id，先去重，避免同一模块在面板上出现两次
    const stored = Array.isArray(order)
      ? [...new Set(order.filter((id) => wanted.includes(id)))]
      : [];
    // 存储顺序优先；缺漏的先按该区域默认顺序、再按模块默认顺序补在末尾
    for (const id of [...regionDefaults, ...WIDGET_MODULE_IDS]) {
      if (wanted.includes(id) && !stored.includes(id)) stored.push(id);
    }
    return stored;
  };

  return {
    version: 3,
    modules,
    orderFull: reconcile(source.orderFull, 'full', defaults.orderFull),
    orderMini: reconcile(source.orderMini, 'mini', defaults.orderMini),
    orderHidden: reconcile(source.orderHidden, 'hidden', defaults.orderHidden)
  };
}

// 额度使用率推导（content/background 共用）：used 缺省时用 limit - remaining
function quotaPercentage(detail) {
  const limit = Number(detail?.limit);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const explicitUsed = Number(detail?.used);
  const used = Number.isFinite(explicitUsed) && explicitUsed >= 0
    ? explicitUsed
    : Math.max(0, limit - (Number(detail?.remaining) || 0));
  return (used / limit) * 100;
}

const KimiMetrics = {
  boosterBalanceYuan,
  buildHeatmapData,
  cacheReadPercentage,
  CHART_RANGES,
  aggregateSpeed,
  decodeSpeed,
  defaultWidgetConfig,
  formatTokenCount,
  formatPercentage,
  listDayKeysBetween,
  normalizeUsage,
  normalizeWidgetConfig,
  PET_STATS,
  pruneDailyUsage,
  pruneHourlyUsage,
  quotaPercentage,
  sumUsageBetween,
  toNonNegativeInteger,
  totalInputTokens,
  usageDayKey,
  usageHourKey,
  WIDGET_MODULE_IDS,
  WIDGET_SHOW_STATES
};

export {
  boosterBalanceYuan,
  buildHeatmapData,
  cacheReadPercentage,
  CHART_RANGES,
  aggregateSpeed,
  decodeSpeed,
  defaultWidgetConfig,
  formatTokenCount,
  formatPercentage,
  listDayKeysBetween,
  normalizeUsage,
  normalizeWidgetConfig,
  PET_STATS,
  pruneDailyUsage,
  pruneHourlyUsage,
  quotaPercentage,
  sumUsageBetween,
  toNonNegativeInteger,
  totalInputTokens,
  usageDayKey,
  usageHourKey,
  WIDGET_MODULE_IDS,
  WIDGET_SHOW_STATES,
  KimiMetrics
};
