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
  decodeSpeed,
  SECONDARY_MODEL_PLACEHOLDER,
  toNonNegativeInteger
} from '../metrics.js';
import { t } from '../i18n.js';

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
  // 按「代理 × 模型」的拆分：agentModels[代理 id][模型名] = 该模型用量。
  // 键是原始模型名（子代理记录里可能是 __secondary__ 占位符），空串表示
  // 「归不到具体模型」（实时事件不带模型且本地汇总里也没有）。合计恒等于
  // agentTotals[代理 id]（见 seedSessionAgent / noteAgentUsage）。
  agentModels: { main: {} },
  // 每个代理的「当前模型」：实时事件不带模型名时用量记到它头上，
  // 否则会凭空多出一行归不到模型的用量
  agentModelHint: {},
  // 子代理显示顺序：按本会话首次出现排序；模型名来自 CLI 扫描的按代理汇总
  sessionAgentOrder: ['main'],
  // CLI 配置里的次级模型真名（config.toml [secondary_model]，需授权 .kimi-code 根目录）
  secondaryModelName: '',
  // 本地 CLI 扫描的按会话汇总（usage-daily.js 带来的 sessions 字段）：
  // 切会话时做恢复底数，键 session id
  cliSessionSummary: {},
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
  usageHourlyCache: {},
  cliUsageConnected: false,
  // 外部账户最近一次拉取结果
  externalProviders: [],
  // 客户端里配了、但面板查不到用量的供应商（未适配 / 没配 key / 托管账号）。
  // 按方案 B 不进常规列表，只在编辑模式的账户清单里列出来并标注原因。
  externalUnsupported: [],
  // 未授权时状态灯恒红（WS 断开优先显示未连接）
  quotaAuthRequired: false,
  // 本轮回答进行中（pet 域写，渲染层读）
  petTurnActive: false
};

// 显示名：主代理 / 子代理 1 / 子代理 2…（按本会话首次出现顺序）
export function agentDisplayName(agentId) {
  if (agentId === 'main') return t('主代理');
  const index = panel.sessionAgentOrder.indexOf(agentId);
  return index > 0 ? t('子代理 {index}', { index }) : t('子代理');
}

/** 模型名 → 显示名：占位符（子代理记录只写 `__secondary__`）回落到 CLI 配置的
 *  次级模型名；再去掉 kimi-code/ 与 kimi- 前缀，窄面板里尽量多保留可辨识部分。
 *  空串表示「归不到具体模型」，原样返回空——由渲染层给「主代理/子代理」兜底文案。 */
export function modelDisplayName(model) {
  const name = typeof model === 'string' ? model.trim() : '';
  if (name !== SECONDARY_MODEL_PLACEHOLDER) {
    return name ? String(name).replace(/^kimi-code\//, '').replace(/^kimi-/, '') : '';
  }
  const fallback = panel.secondaryModelName || '';
  return fallback ? String(fallback).replace(/^kimi-code\//, '').replace(/^kimi-/, '') : '';
}

// 展示排序用的量：输入（含缓存读）+ 输出，与代理合计同口径
function metricWeight(metric) {
  return totalInputTokens(metric) + toNonNegativeInteger(metric?.outputTokens);
}

/** 该代理用得最多的模型（编辑模式里给代理行标注用） */
export function agentModelLabel(agentId) {
  const models = panel.agentModels[agentId] || {};
  const top = Object.entries(models).sort((a, b) => metricWeight(b[1]) - metricWeight(a[1]))[0];
  return modelDisplayName(top ? top[0] : '');
}

/** 该代理的展示行：一个模型一行、用量大的在前，绝不合并——同一个代理中途换过
 *  模型是多行，同一个模型的多个子代理也各占一行（键是代理 id）。
 *  模型信息缺失（只有实时累计、汇总里没有）时给一行兜底，用量取代理合计，
 *  保证「各行之和 == 代理合计」这个不变式在渲染侧也成立。 */
export function agentModelRows(agentId) {
  const rows = Object.entries(panel.agentModels[agentId] || {})
    .map(([model, totals]) => ({ model, totals }))
    .sort((a, b) => metricWeight(b.totals) - metricWeight(a.totals));
  if (rows.length) return rows;
  return [{ model: '', totals: panel.agentTotals[agentId] || emptyAgentMetric() }];
}

/** 本地汇总的桶（{input 含缓存, output, cacheRead}）→ 面板内的代理计数
 *  （{inputTokens 只记非缓存, …}）。换算只在这一处做：换算了两次就是把缓存
 *  算两遍，两边相加必然虚高。 */
function bucketToAgentMetric(bucket) {
  const cacheReadTokens = toNonNegativeInteger(bucket?.cacheRead);
  return {
    inputTokens: Math.max(0, toNonNegativeInteger(bucket?.input) - cacheReadTokens),
    outputTokens: toNonNegativeInteger(bucket?.output),
    cacheReadTokens,
    cacheCreationTokens: 0
  };
}

function addIntoAgentMetric(target, source) {
  target.inputTokens += toNonNegativeInteger(source?.inputTokens);
  target.outputTokens += toNonNegativeInteger(source?.outputTokens);
  target.cacheReadTokens += toNonNegativeInteger(source?.cacheReadTokens);
  target.cacheCreationTokens += toNonNegativeInteger(source?.cacheCreationTokens);
  return target;
}

export function registerSessionAgent(agentId) {
  if (!panel.agentTotals[agentId]) panel.agentTotals[agentId] = emptyAgentMetric();
  if (!panel.agentModels[agentId]) panel.agentModels[agentId] = {};
  if (!panel.sessionAgentOrder.includes(agentId)) panel.sessionAgentOrder.push(agentId);
  return panel.agentTotals[agentId];
}

/** 用本地汇总（wire.jsonl 扫描）里的某个代理覆盖面板上的该代理：
 *  按模型拆分与代理合计一起装，合计 = Σ 各模型。 */
export function seedSessionAgent(agentId, buckets) {
  const models = {};
  const total = emptyAgentMetric();
  for (const [model, bucket] of Object.entries(buckets || {})) {
    const cell = bucketToAgentMetric(bucket);
    models[model] = cell;
    addIntoAgentMetric(total, cell);
  }
  panel.agentModels[agentId] = models;
  panel.agentTotals[agentId] = total;
  registerSessionAgent(agentId);
  // 当前模型 = 用量最大者：实时事件不带模型名时记到它头上
  const top = Object.entries(models).sort((a, b) => metricWeight(b[1]) - metricWeight(a[1]))[0];
  if (top) panel.agentModelHint[agentId] = top[0];
}

/** 实时用量落桶并累计该代理合计：优先事件自带的模型名，其次该代理的当前模型，
 *  最后用空键（渲染层按「归不到具体模型」兜底显示）。 */
export function noteAgentUsage(agentId, model, usage) {
  registerSessionAgent(agentId);
  const named = typeof model === 'string' && model.trim() ? model.trim() : '';
  if (named) panel.agentModelHint[agentId] = named;
  const key = named || panel.agentModelHint[agentId] || '';
  const models = panel.agentModels[agentId];
  const cell = models[key] || (models[key] = emptyAgentMetric());
  addIntoAgentMetric(cell, usage);
  addIntoAgentMetric(panel.agentTotals[agentId], usage);
  return cell;
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

// 清空按「代理 × 模型」的拆分与当前模型标记（两者是同一份状态的两半）。
// 原地清键、不换对象：渲染层持有的是这里的长生命周期对象引用
function clearAgentModels() {
  Object.keys(panel.agentModels).forEach((key) => delete panel.agentModels[key]);
  Object.assign(panel.agentModels, { main: {} });
  Object.keys(panel.agentModelHint).forEach((key) => delete panel.agentModelHint[key]);
}

/** 清空本会话的代理维度（合计、按模型拆分、当前模型、显示顺序），
 *  回到「只有主代理、全零」的初始态。切会话/重置面板/清历史三处共用。 */
export function resetSessionAgents() {
  Object.keys(panel.agentTotals).forEach((key) => delete panel.agentTotals[key]);
  Object.assign(panel.agentTotals, { main: emptyAgentMetric() });
  panel.sessionAgentOrder.length = 0;
  panel.sessionAgentOrder.push('main');
  clearAgentModels();
}

// 清空会话历史（折线、代理统计），用于快照失败或切会话后的本地恢复
export function clearSessionHistory() {
  panel.metrics.lastDuration = 0;
  panel.sessionSamples.length = 0;
  panel.turnDurations.length = 0;
  resetSessionAgents();
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
  resetSessionAgents();
}
