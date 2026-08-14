/**
 * 面板状态容器
 *
 * 职责边界：
 * - 集中维护内容脚本的面板可变状态（metrics、样本、代理统计、子代理集合等）。
 * - 以单个导出对象实现跨模块共享，数组/对象身份在页面生命周期内保持稳定。
 * - 提供纯状态操作助手，不依赖 DOM / chrome API / WebSocket。
 */

import {
  normalizeUsage,
  normalizeWidgetConfig,
  totalInputTokens,
  decodeSpeed
} from '../metrics.js';

// 会话内逐 step 样本与逐轮耗时样本只保留最近 50 条
const SESSION_SAMPLE_LIMIT = 50;

export function emptyAgentMetric() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

export const panel = {
  metrics: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    lastDuration: 0,
    agentStatus: 'idle'
  },
  // 逐 step 样本：{ input, output, cachePct, speed, turnEnd? }，整宽模块的折线图数据源
  sessionSamples: [],
  // 逐轮耗时样本（上轮耗时模块的折线图数据源）
  turnDurations: [],
  // 当前会话按代理的计数器；'main' 为主代理，其余为子代理 id（agent-N）
  agentTotals: { main: emptyAgentMetric() },
  // 子代理显示顺序：按本会话首次出现排序；模型名来自 CLI 扫描的按代理汇总
  sessionAgentOrder: ['main'],
  agentTopModels: {},
  // CLI 配置里的次级模型真名（config.toml [secondary_model]，需授权 .kimi-code 根目录）
  secondaryModelName: '',
  // 正在工作中的子代理（subagent.* 生命周期事件维护）
  activeSubagents: new Set(),

  // 模块配置（chrome.storage.local 加载前先用默认值）
  widgetConfig: normalizeWidgetConfig(null),
  // 面板 DOM 引用缓存（cacheElements 重建；渲染层只读）
  els: null,
  // 额度与余额的最近渲染值（结构重建后用于重绘）
  lastQuotaPct: { '5h': null, week: null, month: null },
  quotaResetAt: { '5h': null, week: null, month: null },
  lastWallet: null,
  // 本地 CLI 长期统计缓存与连接状态
  usageDailyCache: {},
  cliUsageConnected: false,
  // 外部账户最近一次拉取结果
  externalProviders: [],
  // 未授权时状态灯恒红（WS 断开优先显示未连接）
  quotaAuthRequired: false,
  // 本轮回答进行中（pet 域写，渲染层读）
  petTurnActive: false
};

// 显示名：主代理 / 子代理 1 / 子代理 2…（按本会话首次出现顺序）
export function agentDisplayName(agentId) {
  if (agentId === 'main') return '主代理';
  const index = panel.sessionAgentOrder.indexOf(agentId);
  return index > 0 ? `子代理 ${index}` : '子代理';
}

export function agentModelLabel(agentId) {
  let model = panel.agentTopModels[agentId];
  // 子代理的 usage 记录只有 __secondary__ 占位符；且 kimi 目前只支持一种子代理模型——
  // 模型缺失（种子未覆盖、实时事件不带模型）时同样回退到 CLI 配置的次级模型名，
  // 保证同会话子代理 label 一致，分组渲染合并为一行 ×N
  if (model === '__secondary__' || (agentId !== 'main' && !model)) {
    model = panel.secondaryModelName || '';
  }
  if (!model) return '';
  // 去掉 kimi-code/ 与 kimi- 前缀，窄面板里尽量多保留可辨识部分
  return String(model).replace(/^kimi-code\//, '').replace(/^kimi-/, '');
}

export function registerSessionAgent(agentId) {
  if (!panel.agentTotals[agentId]) {
    panel.agentTotals[agentId] = emptyAgentMetric();
    panel.sessionAgentOrder.push(agentId);
  }
}

// 三个额度模块全部隐藏且余额也隐藏时暂停拉取（额度预警通知也随之停用），恢复显示即恢复
export function quotaPollingWanted() {
  const modules = panel.widgetConfig.modules;
  const quotaVisible = ['quota5h', 'quotaWeek'].some(
    (id) => modules[id]?.show !== 'hidden'
  );
  const balanceVisible = modules.header?.show !== 'hidden' && modules.header?.showBalance !== false;
  const petBalanceVisible =
    modules.pet?.show !== 'hidden' && modules.pet?.stat === 'balance';
  return quotaVisible || balanceVisible || petBalanceVisible;
}

// 记录本步样本（折线图数据源，实时与重放共用）；速度/命中率无法计算时为 null，渲染跳过
export function pushStepSample(payload) {
  const usage = normalizeUsage(payload.usage || payload.token_usage);
  const streamDuration = payload.llmStreamDurationMs ?? payload.llmServerDecodeMs;
  const speed = decodeSpeed(usage.outputTokens, streamDuration);
  const stepInput = totalInputTokens(usage);
  panel.sessionSamples.push({
    input: stepInput,
    output: usage.outputTokens,
    cachePct: stepInput > 0 ? (usage.cacheReadTokens / stepInput) * 100 : null,
    speed,
    outMs: Number.isFinite(Number(streamDuration)) ? Number(streamDuration) : null
  });
  if (panel.sessionSamples.length > SESSION_SAMPLE_LIMIT) panel.sessionSamples.shift();
}

// 重放的轮次结束：只记耗时样本与轮末标记，不播 Stars、不动状态
export function pushReplayedTurnDuration(payload) {
  const duration = Number(payload.durationMs ?? payload.duration_ms ?? payload.duration);
  if (Number.isFinite(duration) && duration > 0) {
    panel.metrics.lastDuration = duration;
    panel.turnDurations.push(duration);
    if (panel.turnDurations.length > SESSION_SAMPLE_LIMIT) panel.turnDurations.shift();
  }
  const lastSample = panel.sessionSamples[panel.sessionSamples.length - 1];
  if (lastSample) lastSample.turnEnd = true;
}

// 标记折线图最后一个 step 为轮次结束节点
export function markLastSampleTurnEnd() {
  const lastSample = panel.sessionSamples[panel.sessionSamples.length - 1];
  if (lastSample) lastSample.turnEnd = true;
}

// 记录本轮耗时样本（实时 turn.ended 用）
export function recordTurnDuration(duration) {
  panel.metrics.lastDuration = duration;
  panel.turnDurations.push(duration);
  if (panel.turnDurations.length > SESSION_SAMPLE_LIMIT) panel.turnDurations.shift();
}

// 清空会话历史（折线、代理统计），用于快照失败或切会话后的本地恢复
export function clearSessionHistory() {
  panel.metrics.lastDuration = 0;
  panel.sessionSamples.length = 0;
  panel.turnDurations.length = 0;
  Object.keys(panel.agentTotals).forEach((key) => delete panel.agentTotals[key]);
  Object.assign(panel.agentTotals, { main: emptyAgentMetric() });
  panel.sessionAgentOrder.length = 0;
  panel.sessionAgentOrder.push('main');
  Object.keys(panel.agentTopModels).forEach((key) => delete panel.agentTopModels[key]);
}

// 重置面板数值（保留游标），用于无本地底数的新会话
export function resetMetrics() {
  panel.metrics.inputTokens = 0;
  panel.metrics.outputTokens = 0;
  panel.metrics.cacheReadTokens = 0;
  panel.metrics.cacheCreationTokens = 0;
  panel.metrics.lastDuration = 0;
  panel.metrics.agentStatus = 'idle';
  // 游标不在这里重置：startSession 已统一归零，
  // 空壳快照/快照失败只是数据不可用，不能据此把游标打回 0 触发全量重放
  panel.sessionSamples.length = 0;
  panel.turnDurations.length = 0;
  Object.keys(panel.agentTotals).forEach((key) => delete panel.agentTotals[key]);
  Object.assign(panel.agentTotals, { main: emptyAgentMetric() });
  panel.sessionAgentOrder.length = 0;
  panel.sessionAgentOrder.push('main');
  Object.keys(panel.agentTopModels).forEach((key) => delete panel.agentTopModels[key]);
}
