(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.KimiMetrics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SPEED_SAMPLE_WINDOW = 5;
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
    return total > 0 ? Math.round((usage.cacheReadTokens / total) * 100) : null;
  }

  /* ---------- 按天消耗量累计（popup 消耗量板块数据源） ---------- */

  // 本地时区的 'YYYY-MM-DD'，字典序即时间序，可直接字符串比较
  function usageDayKey(date = new Date()) {
    const d = date instanceof Date ? date : new Date(date);
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${month}-${day}`;
  }

  // 桶结构：{ input, output, cacheRead, sub? }，input 为总输入（含缓存读/写）；
  // isSubagent 为 true 时同额累加进 sub 子桶，供主/子代理分维度展示
  function accumulateDailyUsage(daily, dayKey, usage, isSubagent = false) {
    const next = { ...(daily && typeof daily === 'object' ? daily : {}) };
    const bucket = { input: 0, output: 0, cacheRead: 0, ...(next[dayKey] || {}) };
    const input = totalInputTokens(usage);
    const output = toNonNegativeInteger(usage.outputTokens);
    const cacheRead = toNonNegativeInteger(usage.cacheReadTokens);
    bucket.input += input;
    bucket.output += output;
    bucket.cacheRead += cacheRead;
    if (isSubagent) {
      const sub = { input: 0, output: 0, cacheRead: 0, ...(bucket.sub || {}) };
      sub.input += input;
      sub.output += output;
      sub.cacheRead += cacheRead;
      bucket.sub = sub;
    }
    next[dayKey] = bucket;
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

  // 枚举范围内的每个自然日 key（含端点），无记录的日期也会列出，供图表补零
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

  function appendSpeedSample(samples, speed) {
    if (!Number.isFinite(speed) || speed <= 0) return [...samples].slice(-SPEED_SAMPLE_WINDOW);
    return [...samples, speed].slice(-SPEED_SAMPLE_WINDOW);
  }

  function medianSpeed(samples) {
    if (!samples.length) return 0;
    const sorted = [...samples].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
      ? sorted[middle]
      : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
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
    'quota5h', 'quotaWeek', 'usageChart', 'pet'
  ];
  const USAGE_DAILY_STORAGE_KEY = 'usageDaily';
  const WIDGET_SHOW_STATES = ['full', 'mini', 'hidden'];
  const CHART_RANGES = ['week', 'month'];
  const PET_STATS = ['daily', 'input', 'output', 'cache', 'speed', 'balance'];
  const BALL_LINKS = ['none', 'console', 'subscription'];
  const BALANCE_LINKS = ['subscription', 'console'];

  function defaultWidgetConfig() {
    return {
      version: 3,
      modules: {
        header: { show: 'hidden', span: 2, showBalance: true, balanceLink: 'subscription' },
        input: { show: 'full', span: 1 },
        cache: { show: 'full', span: 1 },
        output: { show: 'full', span: 1 },
        speed: { show: 'full', span: 1 },
        duration: { show: 'hidden', span: 2 },
        quota5h: { show: 'mini', span: 1, pace: true },
        quotaWeek: { show: 'mini', span: 1, pace: true },
        usageChart: { show: 'full', span: 2, chartRange: 'week' },
        pet: { show: 'mini', span: 2, stat: 'daily', sidebarTidy: true, ballLink: 'none' }
      },
      orderFull: ['input', 'cache', 'output', 'speed', 'usageChart'],
      orderMini: ['pet', 'quota5h', 'quotaWeek'],
      orderHidden: ['header', 'duration']
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
      }
      modules[id] = normalized;
    }

    const reconcile = (order, region, regionDefaults) => {
      const wanted = WIDGET_MODULE_IDS.filter((id) => modules[id].show === region);
      const stored = Array.isArray(order) ? order.filter((id) => wanted.includes(id)) : [];
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

  /* ---------- 会话级用量持久化（导出与面板恢复） ---------- */

  // 分键存储：每会话一个键（usageSession:<id>），索引键记录活跃时间与字节数。
  // 步数/轮次不设条数上限；容量是唯一剪枝标准：索引总量超 6MB 按最旧会话逐出
  // （chrome.storage.local 总限额 10MB，其余键合计 <200KB，6MB ≈ 8.5 万步）
  const SESSIONS_MAX_BYTES = 6_000_000;
  const SESSION_KEY_PREFIX = 'usageSession:';
  const SESSION_INDEX_KEY = 'usageSessionsIndex';

  // 每会话一个键：避免整表读-改-写随总量放大
  function sessionStorageKey(sessionId) {
    return `${SESSION_KEY_PREFIX}${sessionId}`;
  }

  // 索引条目：updatedAt 用于新旧排序，bytes 用于容量累计（与存储序列化口径近似）
  function sessionIndexMeta(record, key) {
    return {
      updatedAt: record?.updatedAt || '',
      bytes: String(key).length + JSON.stringify(record || {}).length
    };
  }

  // 容量剪枝：索引总量超 maxBytes 时，按最旧会话逐出直到降回预算内
  function sessionIdsToDrop(index, maxBytes = SESSIONS_MAX_BYTES) {
    const entries = Object.entries(index || {})
      .map(([id, meta]) => ({
        id,
        updatedAt: Date.parse(meta?.updatedAt || '') || 0,
        bytes: Number(meta?.bytes) || 0
      }))
      .sort((a, b) => a.updatedAt - b.updatedAt);
    let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    const drop = [];
    while (drop.length < entries.length && total > maxBytes) {
      total -= entries[drop.length].bytes;
      drop.push(entries[drop.length].id);
    }
    return drop;
  }

  function emptySessionUsage(record) {
    return {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      lastDuration: 0,
      maxSeq: 0,
      maxTurnSeq: -1,
      steps: [],
      durations: [],
      ...(record && typeof record === 'object' ? record : {})
    };
  }

  // 每个 step 累加一次（调用方已完成 sessionId+seq 去重）；steps 全量保留，剪枝见 pruneSessionUsage
  function accumulateSessionUsage(record, usage, speed, seq) {
    const next = emptySessionUsage(record);
    const input = totalInputTokens(usage);
    const output = toNonNegativeInteger(usage.outputTokens);
    const cacheRead = toNonNegativeInteger(usage.cacheReadTokens);
    next.input += input;
    next.output += output;
    next.cacheRead += cacheRead;
    next.cacheCreation += toNonNegativeInteger(usage.cacheCreationTokens);
    next.maxSeq = Math.max(toNonNegativeInteger(next.maxSeq), toNonNegativeInteger(seq));
    next.steps = [
      ...(Array.isArray(next.steps) ? next.steps : []),
      {
        input,
        output,
        cachePct: input > 0 ? (cacheRead / input) * 100 : null,
        speed: Number.isFinite(speed) && speed > 0 ? Math.round(speed) : null
      }
    ];
    next.updatedAt = new Date().toISOString();
    return next;
  }

  // 每轮结束追加一次耗时；maxTurnSeq 供调用方去重（同会话多标签页）
  function appendTurnDuration(record, durationMs, seq) {
    const next = emptySessionUsage(record);
    const duration = toNonNegativeInteger(durationMs);
    next.lastDuration = duration;
    next.durations = [
      ...(Array.isArray(next.durations) ? next.durations : []),
      duration
    ];
    if (Number.isFinite(seq)) next.maxTurnSeq = seq;
    next.updatedAt = new Date().toISOString();
    return next;
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

  return {
    accumulateDailyUsage,
    accumulateSessionUsage,
    appendSpeedSample,
    appendTurnDuration,
    boosterBalanceYuan,
    cacheReadPercentage,
    CHART_RANGES,
    decodeSpeed,
    defaultWidgetConfig,
    formatTokenCount,
    listDayKeysBetween,
    medianSpeed,
    normalizeUsage,
    normalizeWidgetConfig,
    PET_STATS,
    pruneDailyUsage,
    quotaPercentage,
    SESSION_INDEX_KEY,
    SESSION_KEY_PREFIX,
    SESSIONS_MAX_BYTES,
    sessionIdsToDrop,
    sessionIndexMeta,
    sessionStorageKey,
    sumUsageBetween,
    toNonNegativeInteger,
    totalInputTokens,
    USAGE_DAILY_STORAGE_KEY,
    usageDayKey,
    WIDGET_MODULE_IDS,
    WIDGET_SHOW_STATES
  };
});
