/**
 * 渲染层
 *
 * 职责边界：
 * - 把 panel-state 的状态画到面板 DOM（panel.els）上，不产生业务数据。
 * - 跨域动作通过 initRender 注入的钩子回调（宠物状态联动、额度到点补拉），
 *   其余状态全部直接读 panel-state.js。
 */

import {
  boosterBalanceYuan,
  cacheReadPercentage,
  formatPercentage,
  aggregateSpeed,
  formatTokenCount,
  listDayKeysBetween,
  sumUsageBetween,
  totalInputTokens,
  usageDayKey
} from '../metrics.js';
import { panel, agentModelLabel, emptyAgentMetric } from './panel-state.js';
import {
  escapeHtml,
  fmtDuration,
  progressClass,
  PET_ANSWER_STATUSES
} from './utils.js';
import { t, statusText } from '../i18n.js';

const STATUS_MIN_DISPLAY_MS = 1_500;
const CHART_RANGE_DAYS = { week: 7, month: 30 };
// 存原始键，渲染时 t()——模块加载期 t() 会被当时语言冻结，切换语言后不更新
const CHART_RANGE_LABELS = { week: '7d消耗', month: '30d消耗' };

// 窗口时长：5h 与 API 的 window.duration=300（分钟）一致；本周按 7 天
const QUOTA_WINDOW_MS = { '5h': 300 * 60_000, week: 7 * 24 * 3_600_000 };
// 月度周期按 expireTime 回退一个日历月动态计算（28~31 天随月份变化，不写死 30 天）
function paceWindowMs(prefix, resetMs) {
  if (prefix === 'month' && Number.isFinite(resetMs)) {
    const start = new Date(resetMs);
    start.setMonth(start.getMonth() - 1);
    return resetMs - start.getTime();
  }
  return QUOTA_WINDOW_MS[prefix];
}
const PACE_MODULE_IDS = { '5h': 'quota5h', week: 'quotaWeek', month: 'quotaMonth' };

// 本地引用稳定身份的共享状态（数组/对象在页面生命周期内不会被整体替换）
const {
  metrics,
  sessionSamples,
  turnDurations,
  agentTotals,
  sessionAgentOrder,
  activeSubagents
} = panel;

// 跨域钩子（由 content.js 在装配时注入）
let hooks = {
  isDisposed: () => false,
  petUpdateStatus: null,
  roamPetSetStatus: null,
  onQuotaReset: null
};

export function initRender(nextHooks) {
  hooks = { ...hooks, ...nextHooks };
}

/* ---------- 数值与状态 ---------- */

function currentSpeed() {
  return aggregateSpeed(sessionSamples);
}

export function updateProgress(prefix, percentage) {
  const clamped = Math.max(0, Math.min(100, percentage));
  // 额度 API 的 limit 恒为 100、used 是整数百分比（实测响应），
  // 没有更细的精度，整数显示即可（一位小数只会恒为 .0）
  const displayPercentage = formatPercentage(clamped, 0);
  panel.lastQuotaPct[prefix] = clamped;
  const target = panel.els?.quota[prefix];
  if (!target) return;
  const color = progressClass(clamped);
  if (target.fill) {
    target.fill.style.width = `${clamped}%`;
    target.fill.className = `ksb-progress-fill ${color}`;
  }
  if (target.pct) {
    target.pct.textContent = `${displayPercentage}%`;
    target.pct.className = `ksb-quota-pct ${color}`;
  }
}

export function updateBalance(wallet) {
  // undefined 表示“用缓存值重绘”（结构重建后），null/对象则更新缓存
  if (wallet !== undefined) panel.lastWallet = wallet;
  if (!panel.els?.balance) return;
  const balanceYuan = boosterBalanceYuan(panel.lastWallet);
  panel.els.balance.textContent = balanceYuan != null
    ? `¥${balanceYuan.toFixed(2)}`
    : t('余额 --');
}

export function updateTokenDisplay() {
  if (!panel.els) return;
  if (panel.els.inputTokens) panel.els.inputTokens.textContent = formatTokenCount(totalInputTokens(metrics));
  if (panel.els.outputTokens) panel.els.outputTokens.textContent = formatTokenCount(metrics.outputTokens);
}

export function updateCacheDisplay() {
  if (!panel.els?.cachePct) return;
  const percentage = cacheReadPercentage(metrics);
  panel.els.cachePct.textContent = percentage != null
    ? `${formatPercentage(percentage)}%`
    : '--';
}

export function updatePerfDisplay() {
  if (!panel.els) return;
  if (panel.els.speedVal) {
    const speed = currentSpeed();
    panel.els.speedVal.textContent = speed > 0 ? `${speed}tok/s` : '--';
  }
  if (panel.els.durationSub && panel.els.durationVal) {
    if (metrics.lastDuration > 0) {
      panel.els.durationVal.textContent = fmtDuration(metrics.lastDuration);
      panel.els.durationSub.hidden = false;
    } else {
      panel.els.durationSub.hidden = true;
    }
  }
  // 独立的「上轮耗时」模块
  if (panel.els.durationValue) {
    panel.els.durationValue.textContent = metrics.lastDuration > 0 ? fmtDuration(metrics.lastDuration) : '--';
  }
}

// 状态最短显示时长：任何状态至少停留 1.5 秒，避免思考/回复/调用高速
// 交替时文字一闪而过。挂起期间来的新状态覆盖待生效槽，到点播最新的一个。
let displayedAgentStatus = '';
let statusMinUntil = 0;
let pendingDisplayStatus = null;
let pendingStatusTimer = null;

export function paintAgentStatus(display) {
  if (!panel.els) return;
  if (panel.els.statusDot) panel.els.statusDot.className = `ksb-status-dot ksb-${display}`;
  if (panel.els.agentStatus) panel.els.agentStatus.textContent = statusText(display);
  hooks.petUpdateStatus?.(display);
  hooks.roamPetSetStatus?.(display);
}

export function getDisplayedAgentStatus() {
  return displayedAgentStatus;
}

// 会话切换时放行节流：上一会话挂起的状态不带入新会话
export function resetAgentStatusThrottle() {
  if (pendingStatusTimer) clearTimeout(pendingStatusTimer);
  pendingStatusTimer = null;
  pendingDisplayStatus = null;
  statusMinUntil = 0;
}

export function setAgentStatus(status) {
  metrics.agentStatus = status;
  if (!panel.els) return;
  // 未授权时状态灯恒红（除非 WS 已断开，优先显示未连接）
  const display = panel.quotaAuthRequired && status !== 'offline' ? 'unauthorized' : status;
  // 同状态重绘（如 DOM 重建后）不受最短时长限制
  if (display === displayedAgentStatus) {
    paintAgentStatus(display);
    return;
  }
  const wait = statusMinUntil - Date.now();
  if (wait <= 0) {
    displayedAgentStatus = display;
    statusMinUntil = Date.now() + STATUS_MIN_DISPLAY_MS;
    paintAgentStatus(display);
    return;
  }
  pendingDisplayStatus = display;
  if (!pendingStatusTimer) {
    pendingStatusTimer = setTimeout(() => {
      pendingStatusTimer = null;
      if (hooks.isDisposed()) return;
      const next = pendingDisplayStatus;
      pendingDisplayStatus = null;
      if (next == null || next === displayedAgentStatus) return;
      displayedAgentStatus = next;
      statusMinUntil = Date.now() + STATUS_MIN_DISPLAY_MS;
      paintAgentStatus(next);
    }, wait);
  }
}

export function renderAll() {
  updateTokenDisplay();
  updateCacheDisplay();
  updatePerfDisplay();
  setAgentStatus(metrics.agentStatus);
  renderSparks();
  renderAgents();
  renderExternal();
  renderPetStats();
}

/* ---------- 会话折线（整宽统计模块） ---------- */

const SPARK_DEFS = {
  input: { values: () => sessionSamples.map((s) => s.input), fmt: (v) => formatTokenCount(v), marks: () => sessionSamples.map((s) => s.turnEnd === true) },
  output: { values: () => sessionSamples.map((s) => s.output), fmt: (v) => formatTokenCount(v), marks: () => sessionSamples.map((s) => s.turnEnd === true) },
  cache: { values: () => sessionSamples.map((s) => s.cachePct), fmt: (v) => `${formatPercentage(v)}%`, marks: () => sessionSamples.map((s) => s.turnEnd === true) },
  speed: { values: () => sessionSamples.map((s) => s.speed), fmt: (v) => `${v}tok/s`, marks: () => sessionSamples.map((s) => s.turnEnd === true) },
  duration: { values: () => turnDurations, fmt: (v) => fmtDuration(v) }
};

export function renderSparks() {
  if (!panel.els?.sparks) return;
  for (const [id, def] of Object.entries(SPARK_DEFS)) {
    const svg = panel.els.sparks[id];
    sparkRectCache.delete(svg);
    renderSpark(svg, def.values(), def.fmt, def.marks?.());
  }
}

// 侧栏拖拽改变面板宽度后，圆点反缩放参数（渲染时按当时宽度计算）会过期；
// 监听面板尺寸变化重绘折线，任何宽度下圆点保持正圆
let sparkResizeRaf = 0;
const sparkRectCache = new WeakMap();
export const sparkResizeObserver = new ResizeObserver(() => {
  if (sparkResizeRaf) return;
  sparkResizeRaf = requestAnimationFrame(() => {
    sparkResizeRaf = 0;
    renderSparks();
  });
});

// 100×28 viewBox 的迷你折线：面积淡填充（两端渐隐）+ 折线 + 末点；基线恒含 0。
// preserveAspectRatio="none" 横向拉伸 viewBox，直接画圆会变成扁椭圆；
// 所有圆点用 transform 反缩放，r 按屏幕像素给，任何宽度下都是正圆。
function renderSpark(svg, values, fmt, marks) {
  if (!svg) return;
  const pairs = values
    .map((v, i) => ({ v, turn: marks?.[i] === true }))
    .filter((p) => Number.isFinite(p.v));
  if (!pairs.length) {
    svg.replaceChildren();
    return;
  }
  const pts = pairs.map((p) => p.v);
  const max = Math.max(...pts);
  const min = Math.min(0, ...pts);
  const range = max - min || 1;
  const W = 100;
  const H = 28;
  const P = 2;
  const n = pts.length;
  const coords = pts.map((v, i) => {
    const x = n === 1 ? W / 2 : P + (i / (n - 1)) * (W - 2 * P);
    const y = H - P - ((v - min) / range) * (H - 2 * P);
    return [x, y];
  });
  let rect = sparkRectCache.get(svg);
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    rect = svg.getBoundingClientRect();
    sparkRectCache.set(svg, rect);
  }
  const kx = rect.width > 0 ? rect.width / W : 1;
  const ky = rect.height > 0 ? rect.height / H : 1;
  const dot = (x, y, r, cls) =>
    `<circle class="${cls}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${(1 / kx).toFixed(4)} ${(1 / ky).toFixed(4)})" r="${r}"/>`;
  const linePoints = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lastX, lastY] = coords[n - 1];
  const areaPoints = `${P},${H - P} ${linePoints} ${lastX.toFixed(1)},${H - P}`;
  // 每个样本一组悬浮命中区：整条竖带（对不准点也能触发），悬停显示竖线（上下渐隐）+ 节点圆点 + tooltip
  const spacing = n === 1 ? W - 2 * P : (W - 2 * P) / (n - 1);
  const hits = coords
    .map(([x, y], i) => {
      const fx = x.toFixed(1);
      const rx = Math.max(0, Math.min(W, x - spacing / 2));
      const rw = Math.max(1, Math.min(W, x + spacing / 2) - rx);
      const label = pairs[i].turn ? t('第{n}步 · 本轮结束', { n: i + 1 }) : t('第{n}步', { n: i + 1 });
      return `<g class="ksb-spark-pt"><line class="ksb-spark-pt-line" x1="${fx}" y1="1" x2="${fx}" y2="27" stroke="url(#${svg.id}-linefade)"/>${dot(x, y, 2.6, 'ksb-spark-pt-dot')}<rect class="ksb-spark-hit" x="${rx.toFixed(1)}" y="0" width="${rw.toFixed(1)}" height="28" fill="transparent"><title>${escapeHtml(label)} · ${escapeHtml(fmt(pts[i]))}</title></rect></g>`;
    })
    .join('');
  // 整轮对话结束的步加常驻大节点，与最新点同款；最后一个点常与轮末重叠，画两次无视觉差异
  const turnDots = coords
    .map(([x, y], i) => (pairs[i].turn ? dot(x, y, 2.2, 'ksb-spark-dot') : ''))
    .join('');
  svg.innerHTML = `
    <defs>
      <linearGradient id="${svg.id}-vfade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="currentColor" stop-opacity="1"/>
        <stop offset="1" stop-color="currentColor" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="${svg.id}-linefade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="currentColor" stop-opacity="0"/>
        <stop offset="0.15" stop-color="currentColor" stop-opacity="1"/>
        <stop offset="0.85" stop-color="currentColor" stop-opacity="1"/>
        <stop offset="1" stop-color="currentColor" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="${svg.id}-xfade" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#ffffff" stop-opacity="0"/>
        <stop offset="0.06" stop-color="#ffffff" stop-opacity="1"/>
        <stop offset="0.94" stop-color="#ffffff" stop-opacity="1"/>
        <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
      </linearGradient>
      <mask id="${svg.id}-xmask">
        <rect x="0" y="0" width="100" height="28" fill="url(#${svg.id}-xfade)"/>
      </mask>
    </defs>
    <g mask="url(#${svg.id}-xmask)">
      <polygon class="ksb-spark-area" points="${areaPoints}" fill="url(#${svg.id}-vfade)"/>
      <polyline class="ksb-spark-line" points="${linePoints}"/>
    </g>
    ${turnDots}
    ${dot(lastX, lastY, 2.2, 'ksb-spark-dot')}
    ${hits}`;
}

/* ---------- 消耗量图表模块 ---------- */

export function renderChart() {
  if (!panel.els?.chartBars || !panel.els.chartTotal) return;
  const module = panel.els.chartBars.closest('.ksb-module');
  module?.classList.toggle('ksb-cli-required', !panel.cliUsageConnected);
  if (panel.els.cliLock) panel.els.cliLock.hidden = panel.cliUsageConnected;
  if (!panel.cliUsageConnected) {
    panel.els.chartTotal.textContent = t('需连接');
    if (panel.els.chartHitFull) panel.els.chartHitFull.textContent = '';
    if (panel.els.chartHitShort) panel.els.chartHitShort.textContent = '';
    panel.els.chartBars.replaceChildren();
    return;
  }
  const range = panel.widgetConfig.modules.usageChart?.chartRange || 'week';
  const days = CHART_RANGE_DAYS[range] || 7;
  const endKey = usageDayKey(new Date());
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - (days - 1));
  const startKey = usageDayKey(startDate);
  const sum = sumUsageBetween(panel.usageDailyCache, startKey, endKey);
  if (panel.els.chartLabel) panel.els.chartLabel.textContent = t(CHART_RANGE_LABELS[range] || CHART_RANGE_LABELS.week);
  panel.els.chartTotal.textContent = sum.totalTokens > 0 ? formatTokenCount(sum.totalTokens) : '--';
  const hitPct = sum.cacheHitRate != null ? `${formatPercentage(sum.cacheHitRate * 100)}%` : '';
  if (panel.els.chartHitFull) panel.els.chartHitFull.textContent = hitPct ? t('缓存命中 {pct}', { pct: hitPct }) : '';
  if (panel.els.chartHitShort) panel.els.chartHitShort.textContent = hitPct;
  panel.els.chartBars.replaceChildren();
  const keys = listDayKeysBetween(startKey, endKey);
  const maxTokens = Math.max(
    0,
    ...keys.map((key) => {
      const bucket = panel.usageDailyCache[key];
      return bucket ? bucket.input + bucket.output : 0;
    })
  );
  for (const key of keys) {
    const bucket = panel.usageDailyCache[key];
    const tokens = bucket ? bucket.input + bucket.output : 0;
    // sub 子桶存在时拆分主/子代理，堆叠展示（主灰在底、子绿在上），与 popup 口径一致
    const subTokens = bucket?.sub ? bucket.sub.input + bucket.sub.output : 0;
    const mainTokens = tokens - subTokens;
    const col = document.createElement('span');
    col.className = 'ksb-chart-col';
    col.title = subTokens > 0
      ? t('{date} · 主 {main} · 子 {sub}', { date: key.slice(5), main: formatTokenCount(mainTokens), sub: formatTokenCount(subTokens) })
      : `${key.slice(5)} · ${formatTokenCount(tokens)}`;
    const stack = document.createElement('span');
    stack.className = 'ksb-chart-stack';
    if (subTokens > 0 && maxTokens > 0) {
      const subBar = document.createElement('span');
      subBar.className = 'ksb-chart-bar sub';
      subBar.style.height = `${(subTokens / maxTokens) * 100}%`;
      stack.append(subBar);
    }
    const mainBar = document.createElement('span');
    mainBar.className = subTokens > 0 ? 'ksb-chart-bar flat' : 'ksb-chart-bar';
    mainBar.style.height = `${Math.max(8, maxTokens > 0 ? (mainTokens / maxTokens) * 100 : 8)}%`;
    stack.append(mainBar);
    col.append(stack);
    panel.els.chartBars.append(col);
  }
}

// 子代理总览模块：主代理一行置顶；子代理按模型分组（同模型合并为一行，
// 多实例标注 ×N）。徽标常态灰色，对应代理工作时点亮（主淡蓝、子淡绿）
export function renderAgents() {
  if (!panel.els?.agentsList) return;
  const hiddenAgents = panel.widgetConfig.modules.agents?.hiddenAgents || [];
  const mainWorking = panel.petTurnActive || PET_ANSWER_STATUSES.includes(metrics.agentStatus);

  // 子代理按模型名分组汇总
  const groups = new Map();
  for (const agentId of sessionAgentOrder) {
    if (agentId === 'main' || hiddenAgents.includes(agentId)) continue;
    const totals = agentTotals[agentId];
    if (!totals) continue;
    const key = agentModelLabel(agentId);
    let group = groups.get(key);
    if (!group) {
      group = { ...emptyAgentMetric(), working: false, count: 0 };
      groups.set(key, group);
    }
    group.inputTokens += totals.inputTokens;
    group.outputTokens += totals.outputTokens;
    group.cacheReadTokens += totals.cacheReadTokens;
    group.cacheCreationTokens += totals.cacheCreationTokens;
    group.working = group.working || activeSubagents.has(agentId);
    group.count += 1;
  }

  const rows = [];
  const pushRow = ({ isMain, totals, working, name, title }) => {
    const hasUsage = totalInputTokens(totals) > 0 || totals.outputTokens > 0;
    // 无用量的子代理组只在「工作中」时占位；主代理始终显示
    if (!hasUsage && !working && !isMain) return;
    const hit = cacheReadPercentage(totals);
    const badge = isMain
      ? `<span class="ksb-agent-badge main${working ? ' on' : ''}">主</span>`
      : `<span class="ksb-agent-badge sub${working ? ' on' : ''}">子</span>`;
    rows.push(`
      <div class="ksb-agent-row${isMain ? ' main' : ''}" title="${escapeHtml(title)}">
        <span class="ksb-agent-id">${badge}</span>
        <span class="ksb-agent-model">${escapeHtml(name)}</span>
        <span class="ksb-agent-metric m-in">${formatTokenCount(totalInputTokens(totals))}</span>
        <span class="ksb-agent-metric m-out">${formatTokenCount(totals.outputTokens)}</span>
        <span class="ksb-agent-metric m-hit">${hit != null ? `${formatPercentage(hit)}%` : '--'}</span>
      </div>`);
  };

  const mainModel = agentModelLabel('main');
  pushRow({
    isMain: true,
    totals: agentTotals.main || emptyAgentMetric(),
    working: mainWorking,
    name: escapeHtml(mainModel),
    title: `${t('主代理')}${mainModel ? ` · ${mainModel}` : ''}`
  });
  for (const [model, group] of groups) {
    pushRow({
      isMain: false,
      totals: group,
      working: group.working,
      // 模型名缺失（未授权 CLI 读不到次级模型名）时兜底为「子代理」，避免裸 ×N
      name: escapeHtml(`${model || t('子代理')}${group.count > 1 ? ` ×${group.count}` : ''}`),
      title: `${t('子代理')}${model ? ` · ${model}` : ''}${group.count > 1 ? ` ×${group.count}` : ''}`
    });
  }
  panel.els.agentsList.innerHTML = rows.join('');
}

/* ---------- 外部账户模块（DeepSeek / Kimi API / 智谱 / MiniMax） ---------- */

// 格式化单个账户的主数值与子数值：余额类「API余额 ¥4.46」；
// 套餐类「5h 40.0% · 1w 12.0%」；半宽只取主数值 + 次要窗口做下角标
function formatExternalValue(provider) {
  if (provider.error) return { main: t('获取失败'), sub: '', note: provider.error };
  if (provider.kind === 'balance') {
    const main = `${provider.currency}${provider.total.toFixed(2)}`;
    return {
      main,
      sub: '',
      note: t('赠送 {granted} · 充值 {paid}', { granted: `${provider.currency}${provider.granted.toFixed(2)}`, paid: `${provider.currency}${provider.paid.toFixed(2)}` })
    };
  }
  if (provider.windows?.length) {
    const [first, second] = provider.windows;
    const reset = provider.windows.find((w) => w.resetAt)?.resetAt;
    return {
      main: `${formatPercentage(first.pct)}%`,
      sub: second ? `${second.label} ${formatPercentage(second.pct)}%` : '',
      note: [provider.plan, reset ? t('重置 {time}', { time: new Date(reset).toLocaleString() }) : '']
        .filter(Boolean)
        .join(' · ')
    };
  }
  return { main: provider.plan || t('已启用'), sub: '', note: '' };
}

export function renderExternal() {
  const hiddenAccounts = panel.widgetConfig.modules.external?.hiddenAccounts || [];
  const visible = panel.externalProviders.filter((p) => !hiddenAccounts.includes(p.id));

  // 半宽：标题换成第一个选中账户的名称，大数字是它的余额/用量百分比
  if (panel.els?.externalTitle) {
    const first = visible[0];
    panel.els.externalTitle.textContent = first ? first.name : t('外部账户');
    if (!first) {
      panel.els.externalValue.textContent = '--';
      panel.els.externalSub.hidden = true;
    } else {
      const formatted = formatExternalValue(first);
      panel.els.externalValue.textContent = formatted.main;
      panel.els.externalSub.textContent = formatted.sub;
      panel.els.externalSub.hidden = !formatted.sub;
    }
  }

  // 整宽：一行一个账户，名称在左、格式化数值在右。
  // 数值的类型前缀（API余额 / 5小时 等）单独成 span，窄面板时整体隐藏只留数字
  if (!panel.els?.externalList) return;
  if (!visible.length) {
    panel.els.externalList.innerHTML =
      `<div class="ksb-external-empty">${t('在扩展弹窗中配置 API Key')}</div>`;
    return;
  }
  // 同一 provider 多个账户时，用 key 尾号区分
  const nameCounts = {};
  for (const p of visible) nameCounts[p.name] = (nameCounts[p.name] || 0) + 1;
  const valueHtml = (provider) => {
    if (provider.error) return t('获取失败');
    if (provider.kind === 'balance') {
      return `<span class="ksb-external-kind">${t('API余额')}</span> ${escapeHtml(provider.currency)}${provider.total.toFixed(2)}`;
    }
    if (provider.windows?.length) {
      return provider.windows
        .map((w) => `<span class="ksb-external-kind">${escapeHtml(w.label)}</span> ${formatPercentage(w.pct)}%`)
        .join(' · ');
    }
    return provider.plan ? escapeHtml(provider.plan) : t('已启用');
  };
  panel.els.externalList.innerHTML = visible
    .map((provider) => {
      const label = nameCounts[provider.name] > 1
        ? `${escapeHtml(provider.name)} ·${escapeHtml(provider.keyTail)}`
        : escapeHtml(provider.name);
      const formatted = formatExternalValue(provider);
      return `
        <div class="ksb-external-row" title="${label}${formatted.note ? ` · ${escapeHtml(formatted.note)}` : ''}">
          <span class="ksb-external-name">${label}</span>
          <span class="ksb-external-value${provider.error ? ' err' : ''}">${valueHtml(provider)}</span>
        </div>`;
    })
    .join('');
}

// 宠物模块右侧数据：六种口径可选（≡ 菜单切换），标签与数值联动
const PET_STAT_DEFS = {
  daily: {
    label: '24h消耗',
    value: () => {
      if (!panel.cliUsageConnected) return t('需连接 CLI');
      const bucket = panel.usageDailyCache[usageDayKey(new Date())];
      const total = bucket ? bucket.input + bucket.output : 0;
      return total > 0 ? formatTokenCount(total) : '--';
    }
  },
  input: { label: '输入', value: () => formatTokenCount(totalInputTokens(metrics)) },
  output: { label: '输出', value: () => formatTokenCount(metrics.outputTokens) },
  cache: {
    label: '缓存命中',
    value: () => {
      const pct = cacheReadPercentage(metrics);
      return pct != null ? `${formatPercentage(pct)}%` : '--';
    }
  },
  speed: {
    label: '速度',
    value: () => {
      const speed = currentSpeed();
      return speed > 0 ? `${speed}tok/s` : '--';
    }
  },
  balance: {
    label: '余额',
    value: () => {
      const yuan = boosterBalanceYuan(panel.lastWallet);
      return yuan != null ? `¥${yuan.toFixed(2)}` : '--';
    }
  }
};

export function renderPetStats() {
  if (!panel.els?.petTotal) return;
  const def = PET_STAT_DEFS[panel.widgetConfig.modules.pet?.stat] || PET_STAT_DEFS.daily;
  if (panel.els.petLabel) panel.els.petLabel.textContent = t(def.label);
  panel.els.petTotal.textContent = def.value();
}

/* ---------- 额度重置倒计时与参照线 ---------- */

// 紧凑格式（额度行内）：45m / 2h30m / 3d5h，与 macOS 菜单栏应用同精度
function fmtCountdown(diffMs) {
  const totalMin = Math.floor(diffMs / 60_000);
  if (totalMin < 1) return t('即将重置');
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  if (hours < 1) return `${totalMin}m`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  if (days >= 1) return `${days}d${restHours ? `${restHours}h` : ''}`;
  return `${hours}h${minutes ? `${minutes}m` : ''}`;
}

// 窄宽度下的单单位格式：45m / 2h / 3d
function fmtCountdownShort(diffMs) {
  const totalMin = Math.floor(diffMs / 60_000);
  if (totalMin < 1) return t('即将重置');
  const hours = Math.floor(totalMin / 60);
  if (hours < 1) return `${totalMin}m`;
  const days = Math.floor(hours / 24);
  if (days >= 1) return `${days}d`;
  return `${hours}h`;
}

// 完整格式（tooltip）：2小时30分钟后重置（07-23 15:00）
function fmtCountdownLong(diffMs, resetMs) {
  const totalMin = Math.floor(diffMs / 60_000);
  const date = new Date(resetMs);
  const abs = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (totalMin < 1) return t('即将重置');
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  const days = Math.floor(hours / 24);
  const text = days >= 1
    ? t('{days}天{hours}小时后重置', { days, hours: hours % 24 })
    : hours >= 1
      ? t('{hours}小时{minutes}分钟后重置', { hours, minutes })
      : t('{totalMin}分钟后重置', { totalMin });
  return `${text}（${abs}）`;
}

// 具体时间格式（≡ 菜单可选）：当天只显示 HH:mm；跨天显示「周三17:45」，
// 窄宽度降级为「周三」，更窄由 CSS 整体隐藏（container ≤155px）
const RESET_WEEKDAYS = [t('周日'), t('周一'), t('周二'), t('周三'), t('周四'), t('周五'), t('周六')];
function fmtResetAbsolute(resetMs, { short = false } = {}) {
  const date = new Date(resetMs);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  if (sameDay) return time;
  const weekday = RESET_WEEKDAYS[date.getDay()];
  return short ? weekday : `${weekday}${time}`;
}

// 到点重置后额度必然变化，提前补一次拉取
let resetRefetchTimer = null;

export function updateResetText(prefix, resetMs) {
  panel.quotaResetAt[prefix] = resetMs;
  updatePaceTick(prefix);
  const element = panel.els?.quota[prefix]?.reset;
  if (!element) return;
  const full = element.querySelector('.ksb-reset-full');
  const short = element.querySelector('.ksb-reset-short');
  // ≡ 菜单「重置时间显示」：倒计时（默认）或具体时间；tooltip 始终保留完整倒计时。
  // 具体时间更宽，挂 ksb-abs 让 CSS 降级断点提前（见 content.css 命名容器 ksb-quota）
  const useAbsolute = panel.widgetConfig.modules[PACE_MODULE_IDS[prefix]]?.resetFormat === 'absolute';
  element.classList.toggle('ksb-abs', useAbsolute);
  if (!Number.isFinite(resetMs)) {
    if (full) full.textContent = '';
    if (short) short.textContent = '';
    setResetTooltip(prefix, '');
    return;
  }
  const diff = resetMs - Date.now();
  if (full) {
    full.textContent = diff > 0
      ? (useAbsolute ? fmtResetAbsolute(resetMs) : fmtCountdown(diff))
      : t('即将重置');
  }
  if (short) {
    short.textContent = diff > 0
      ? (useAbsolute ? fmtResetAbsolute(resetMs, { short: true }) : fmtCountdownShort(diff))
      : t('即将重置');
  }
  setResetTooltip(prefix, fmtCountdownLong(Math.max(diff, 0), resetMs));
  if (diff <= 0 && !resetRefetchTimer) {
    resetRefetchTimer = setTimeout(() => {
      resetRefetchTimer = null;
      hooks.onQuotaReset?.();
    }, 15_000);
  }
}

// 匀速参照：按窗口已流逝比例移动深灰竖标；模块菜单可关闭，resetTime 缺失或剩余异常超过整个窗口时隐藏
export function updatePaceTick(prefix) {
  const tick = panel.els?.quota[prefix]?.pace;
  if (!tick) return;
  if (panel.widgetConfig.modules[PACE_MODULE_IDS[prefix]]?.pace === false) {
    tick.hidden = true;
    return;
  }
  const resetMs = panel.quotaResetAt[prefix];
  const windowMs = paceWindowMs(prefix, resetMs);
  const diff = Number.isFinite(resetMs) ? resetMs - Date.now() : NaN;
  if (!Number.isFinite(diff) || !Number.isFinite(windowMs) || diff > windowMs) {
    tick.hidden = true;
    return;
  }
  const elapsed = Math.max(0, Math.min(1, 1 - diff / windowMs));
  tick.style.left = `${elapsed * 100}%`;
  tick.hidden = false;
}

export function setResetTooltip(prefix, text) {
  const group = panel.els?.quota[prefix]?.pct?.closest('.ksb-quota-group');
  if (group) group.title = text;
}

// 页面销毁时清理渲染层持有的定时器与观察器（content.js dispose 调用）
export function disposeRender() {
  if (pendingStatusTimer) clearTimeout(pendingStatusTimer);
  pendingStatusTimer = null;
  pendingDisplayStatus = null;
  sparkResizeObserver.disconnect();
  if (sparkResizeRaf) cancelAnimationFrame(sparkResizeRaf);
  sparkResizeRaf = 0;
  if (resetRefetchTimer) clearTimeout(resetRefetchTimer);
  resetRefetchTimer = null;
}
