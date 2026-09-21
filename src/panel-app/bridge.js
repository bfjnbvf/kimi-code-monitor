/**
 * 面板数据总线（window.__vibepal.push 队列 + 消息分发）
 *
 * 桌面补丁注入模式的数据入口，推送方两类：
 * - direct.js：kap-server 的 WS 事件与 REST 轮询结果（本文件同目录）；
 * - loader.js：usage-daily.js / external.js 快照（安装器预填 + 技能代查）。
 * msg 形如 { v: 1, type, ... }：
 *   - { type: 'quota', quota: { limit5h: { usedRatio, resetAt }, limit7d: { ... } } }
 *     usedRatio 是 0~1 用量比（×100 后进 updateProgress）；resetAt 为 ISO 时间
 *     （parseResetTime 后进 updateResetText）。可选 wallet 字段透传 updateBalance。
 *   - { type: 'event', event }：kap-server 的 WS 消息（type/payload/agent_id…），
 *     按 websocket-session.js 的实时分支翻译成面板状态（游标/重连/去重不管）。
 *   - { type: 'usageDaily', daily, hourly, secondaryModel }：CLI 长期统计（wire.jsonl
 *     全量扫描），与页内按天积累（accumulate.js）取大合并后写 panel.usageDailyCache。
 *   - { type: 'status', status: 'idle' | 'working' | 'waiting' | 'offline' }：
 *     整体状态灯与宠物联动。
 *   - { type: 'external', providers }：外部账户（DeepSeek/Kimi API/智谱/MiniMax）
 *     抓取结果直写 panel.externalProviders 后重绘。
 *   - { type: 'session', sid, snapshot?: { usage } }：切换当前会话（跟随桌面端
 *     SPA 路由焦点）——清空累计并以 REST 快照的 usage 做底，再重绘。
 *   - 可选 sessionId 字段（任意消息上）：标记当前会话 id（宠物轮次归属用）。
 *
 * push 早于面板装配完成时先入队，markBridgeReady 后按序补发。
 */

import { normalizeUsage } from '../metrics.js';
import { noteStepUsage, mergeDaily, hasAccumulated } from './accumulate.js';
import { summarizeStatus, STATUS_LONG } from './status-copy.js';
import { t } from '../i18n.js';
import { panel, registerSessionAgent, pushStepSample, recordTurnDuration, markLastSampleTurnEnd, resetMetrics } from '../content/panel-state.js';
import {
  setAgentStatus,
  renderAll,
  renderAgents,
  renderChart,
  renderPetStats,
  renderExternal,
  updateBalance,
  updateProgress,
  updateResetText
} from '../content/render.js';
import { petBeginTurn, petCompleteTurn } from '../content/pet-panel.js';
import { parseResetTime } from '../content/utils.js';

const TOOL_STATUS_MIN_MS = 1_500;
const DEFAULT_SESSION_ID = 'panel';

// 整体状态 → 面板状态灯口径（与 WS 事件的显示状态对齐）
const STATUS_MAP = {
  idle: 'idle',
  working: 'thinking',
  waiting: 'idle',
  offline: 'offline'
};

let currentSessionId = DEFAULT_SESSION_ID;

// 工具调用锁：与 websocket-session.js 同策略——结果返回前保持「调用中」，
// 最短可见 1.5s，释放后回到延迟写入的最新工作状态
let activeToolCalls = 0;
let toolStatusUntil = 0;
let toolStatusTimer = null;
let deferredWorkStatus = 'thinking';

export function getSessionId() {
  return currentSessionId;
}

function setAgentWorkStatus(status) {
  deferredWorkStatus = status;
  if (activeToolCalls > 0 || Date.now() < toolStatusUntil) {
    setAgentStatus('executing');
    return;
  }
  setAgentStatus(status);
}

function clearToolStatus() {
  activeToolCalls = 0;
  toolStatusUntil = 0;
  deferredWorkStatus = 'thinking';
  if (toolStatusTimer) clearTimeout(toolStatusTimer);
  toolStatusTimer = null;
}

function beginToolStatus() {
  activeToolCalls += 1;
  toolStatusUntil = Math.max(toolStatusUntil, Date.now() + TOOL_STATUS_MIN_MS);
  if (toolStatusTimer) clearTimeout(toolStatusTimer);
  toolStatusTimer = null;
  setAgentStatus('executing');
}

function finishToolStatus() {
  activeToolCalls = Math.max(0, activeToolCalls - 1);
  if (activeToolCalls > 0) {
    setAgentStatus('executing');
    return;
  }
  const remaining = toolStatusUntil - Date.now();
  if (remaining <= 0) {
    toolStatusUntil = 0;
    setAgentStatus(deferredWorkStatus);
    return;
  }
  if (toolStatusTimer) clearTimeout(toolStatusTimer);
  toolStatusTimer = setTimeout(() => {
    toolStatusTimer = null;
    toolStatusUntil = 0;
    if (activeToolCalls === 0) setAgentStatus(deferredWorkStatus);
  }, remaining);
}

// 事件的子代理身份与归属 agent id：与 websocket-session.js 的取值口径一致
function isSubagentEvent(message, payload) {
  const id = message.agent_id ?? payload.agent_id ?? payload.agentId ?? payload.subagentId;
  return Boolean(id) && id !== 'main';
}

function eventAgentId(message, payload) {
  return message.agent_id ?? payload.agent_id ?? payload.agentId ?? payload.subagentId ?? 'main';
}

function handleStepCompleted(payload, agentId) {
  const usage = normalizeUsage(payload.usage || payload.token_usage);
  panel.metrics.inputTokens += usage.inputTokens;
  panel.metrics.outputTokens += usage.outputTokens;
  panel.metrics.cacheReadTokens += usage.cacheReadTokens;
  panel.metrics.cacheCreationTokens += usage.cacheCreationTokens;

  // 按天自积累（补丁模式无看门狗时长期统计的兜底，详见 accumulate.js）
  noteStepUsage(usage);

  registerSessionAgent(agentId);
  const totals = panel.agentTotals[agentId];
  totals.inputTokens += usage.inputTokens;
  totals.outputTokens += usage.outputTokens;
  totals.cacheReadTokens += usage.cacheReadTokens;
  totals.cacheCreationTokens += usage.cacheCreationTokens;

  pushStepSample(payload);
  renderAll();
}

// agent.status.updated 的收敛逻辑（session.js handleAgentStatus）
function handleAgentStatusEvent(payload) {
  const status = payload.status || payload.agent_status;
  if (status === 'idle' || status === 'waiting') {
    setAgentWorkStatus('idle');
    return;
  }
  if (!panel.petTurnActive) return;
  if (status === 'thinking' || status === 'processing'
    || status === 'running' || status === 'working') {
    setAgentWorkStatus('thinking');
  }
}

// WS 消息 → 面板状态（只做数据累计 + 渲染；游标/重连/去重由 Swift 侧负责）
function handleEvent(message) {
  if (!message || typeof message !== 'object') return;
  if (message.session_id && message.session_id !== currentSessionId) return;
  // 兼容帧式（{type, payload}）与扁平式（字段直接在事件上）两种推送
  const payload = message.payload && typeof message.payload === 'object' ? message.payload : message;

  switch (message.type) {
    case 'turn.started':
      clearToolStatus();
      petBeginTurn();
      setAgentStatus('thinking');
      break;
    case 'turn.step.started':
      setAgentWorkStatus(isSubagentEvent(message, payload) ? 'subagent' : 'thinking');
      break;
    case 'turn.step.completed':
      handleStepCompleted(payload, eventAgentId(message, payload));
      setAgentWorkStatus(isSubagentEvent(message, payload) ? 'subagent' : 'thinking');
      break;
    case 'thinking.delta':
      if (!isSubagentEvent(message, payload) && deferredWorkStatus !== 'thinking') {
        setAgentWorkStatus('thinking');
      }
      break;
    case 'assistant.delta':
      if (!isSubagentEvent(message, payload) && deferredWorkStatus !== 'replying') {
        setAgentWorkStatus('replying');
      }
      break;
    case 'subagent.spawned':
    case 'subagent.started':
    case 'subagent.suspended': {
      const subId = payload.subagentId ?? payload.agentId;
      if (subId) {
        registerSessionAgent(String(subId));
        panel.activeSubagents.add(String(subId));
      }
      setAgentWorkStatus('subagent');
      break;
    }
    case 'subagent.completed':
    case 'subagent.failed': {
      const subId = payload.subagentId ?? payload.agentId;
      if (subId) panel.activeSubagents.delete(String(subId));
      setAgentWorkStatus('thinking');
      break;
    }
    case 'tool.call.started':
      beginToolStatus();
      break;
    case 'tool.result':
      finishToolStatus();
      break;
    case 'turn.ended':
    case 'turn.completed': {
      const duration = Number(payload.durationMs ?? payload.duration_ms ?? payload.duration);
      if (Number.isFinite(duration) && duration > 0) recordTurnDuration(duration);
      clearToolStatus();
      setAgentStatus('idle');
      // 折线图：本轮最后一个 step 样本加常驻大节点，区分轮内调用与整轮结束
      markLastSampleTurnEnd();
      petCompleteTurn();
      renderAll();
      break;
    }
    case 'event.session.work_changed': {
      const busy = Boolean(payload.busy || payload.main_turn_active);
      if (busy && !panel.petTurnActive) break;
      setAgentWorkStatus(busy ? 'thinking' : 'idle');
      break;
    }
    case 'agent.status.updated':
      handleAgentStatusEvent(payload);
      break;
    case 'error':
      // 供应商限流是瞬时状态，显示「限流中」，下一个正常事件会覆盖
      if (payload?.code === 'provider.rate_limit') setAgentStatus('ratelimit');
      break;
    default:
      break;
  }
}

function handleQuota(msg) {
  const quota = msg.quota || {};
  const fiveHour = quota.limit5h || quota['5h'];
  const week = quota.limit7d || quota.limitWeek || quota.week;
  if (fiveHour) {
    const ratio = Number(fiveHour.usedRatio);
    if (Number.isFinite(ratio)) updateProgress('5h', ratio * 100);
    updateResetText('5h', parseResetTime(fiveHour.resetAt));
  }
  if (week) {
    const ratio = Number(week.usedRatio);
    if (Number.isFinite(ratio)) updateProgress('week', ratio * 100);
    updateResetText('week', parseResetTime(week.resetAt));
  }
  // 无 wallet 字段时清空余额显示（与「未拉到余额」口径一致）
  updateBalance(quota.wallet ?? null);
}

// 看门狗文件（wire.jsonl 全量扫描）的原始日数据：与页内积累分开存，
// 每次合并都是「文件 ∪ 积累」按天取大（accumulate.js）
let lastFileDaily = {};

function handleUsageDaily(msg) {
  lastFileDaily = msg.daily && typeof msg.daily === 'object' ? msg.daily : {};
  panel.usageHourlyCache = msg.hourly && typeof msg.hourly === 'object' ? msg.hourly : {};
  panel.secondaryModelName = typeof msg.secondaryModel === 'string' ? msg.secondaryModel : '';
  panel.cliUsageConnected = msg.connected !== false;
  // loader 的状态行读这个标记区分「文件已载入」与「已进渲染层」
  try {
    globalThis.__vibepalDebug = { ...globalThis.__vibepalDebug, usageDailyOk: true };
  } catch (error) {
    // 忽略
  }
  refreshDailyChart();
}

/** 合并「文件 + 页内积累」重绘长期统计；补丁模式无文件时纯靠页内积累 */
export function refreshDailyChart() {
  const merged = mergeDaily(lastFileDaily);
  panel.usageDailyCache = merged;
  if (Object.keys(merged).length > 0) panel.cliUsageConnected = true;
  renderChart();
  renderAgents();
  renderPetStats();
}

function handleStatus(msg) {
  if (typeof msg.sessionId === 'string' && msg.sessionId) currentSessionId = msg.sessionId;
  setAgentStatus(STATUS_MAP[msg.status] || 'idle');
}

// 会话切换（direct.js 按 SPA 路由焦点推送）：清空当前累计，按 REST 快照做底
function handleSessionSwitch(msg) {
  const sid = typeof msg.sid === 'string' ? msg.sid : '';
  if (!sid || sid === currentSessionId) return;
  currentSessionId = sid;
  resetMetrics();
  clearToolStatus();
  const usage = normalizeUsage(msg.snapshot?.usage || msg.snapshot?.total);
  if (usage) {
    panel.metrics.inputTokens = usage.inputTokens;
    panel.metrics.outputTokens = usage.outputTokens;
    panel.metrics.cacheReadTokens = usage.cacheReadTokens;
    panel.metrics.cacheCreationTokens = usage.cacheCreationTokens;
    registerSessionAgent('main');
    panel.agentTotals.main.inputTokens = usage.inputTokens;
    panel.agentTotals.main.outputTokens = usage.outputTokens;
    panel.agentTotals.main.cacheReadTokens = usage.cacheReadTokens;
    panel.agentTotals.main.cacheCreationTokens = usage.cacheCreationTokens;
  }
  setAgentStatus('idle');
  renderAll();
  renderPetStats();
}

// 外部账户（loader 的 external.js 快照，技能 fetch-external.mjs 代查生成）：
// 结果直写并重绘，数据形状与扩展 background/external.js 的 providers 一致
// （{id, name, keyTail, kind, total, granted, paid, currency, windows, plan, error}）
function handleExternal(msg) {
  panel.externalProviders = Array.isArray(msg.providers) ? msg.providers : [];
  renderExternal();
}

function dispatch(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.v != null && msg.v !== 1) {
    console.warn('[Kimi Status] 忽略未知版本的推送消息', msg);
    return;
  }
  if (typeof msg.sessionId === 'string' && msg.sessionId) currentSessionId = msg.sessionId;
  switch (msg.type) {
    case 'quota':
      handleQuota(msg);
      break;
    case 'event':
      handleEvent(msg.event);
      break;
    case 'usageDaily':
      handleUsageDaily(msg);
      break;
    case 'status':
      handleStatus(msg);
      break;
    case 'external':
      handleExternal(msg);
      break;
    case 'session':
      handleSessionSwitch(msg);
      break;
    default:
      break;
  }
}

// 单条消息处理失败只影响自己：记录后继续，排队队列与后续推送不被锁死
// （loader 的数据轮询有内容去重，一旦某条消息抛错且不被吞掉，锁就会永久停在屏幕上）
function safeDispatch(msg) {
  try {
    dispatch(msg);
  } catch (error) {
    console.error('[Kimi Status] 推送消息处理失败', msg?.type, error);
    try {
      globalThis.__vibepalDebug = {
        ...globalThis.__vibepalDebug,
        dispatchError: `${msg?.type}: ${error?.message || error}`
      };
    } catch (e) {
      // 诊断写入失败不影响面板
    }
  }
}

let bridgeReady = false;
const pendingMessages = [];

export function installBridge() {
  globalThis.__vibepal = {
    push: (msg) => {
      if (!bridgeReady) {
        pendingMessages.push(msg);
        return;
      }
      safeDispatch(msg);
    }
  };
}

// 面板装配完成：补发排队期间到达的消息，之后 push 直达
export function markBridgeReady() {
  if (bridgeReady) return;
  bridgeReady = true;
  while (pendingMessages.length) safeDispatch(pendingMessages.shift());
}

/* ---------- 状态文案 ticker：归并各环节状态 → 锁位句子与短词 ---------- */

let disconnectedSince = 0;

// 数据未就绪期间每秒刷新：更新锁位状态句（人话）并把等级挂到 panel 上
// 供渲染层窄位（吉祥物旁 / 图表汇总位）取短词。诊断技术串由 loader 写。
function tickStatusSentence() {
  const d = globalThis.__vibepalDebug || {};
  const wsState = String(d.wsState || '');
  const disconnected = d.kapKnown === false
    || wsState.startsWith('closed')
    || wsState === '等kap源';
  if (disconnected && !disconnectedSince) disconnectedSince = Date.now();
  if (!disconnected) disconnectedSince = 0;
  const level = summarizeStatus({
    dispatchError: d.dispatchError,
    connected: panel.cliUsageConnected,
    usageDailyOk: d.usageDailyOk,
    hasAccum: hasAccumulated(),
    fileState: d.fileState,
    kapKnown: d.kapKnown,
    wsState: d.wsState,
    connectingMs: disconnectedSince ? Date.now() - disconnectedSince : 0
  });
  panel.statusLevel = level;
  const sentence = document.getElementById('ksb-status-sentence');
  if (sentence && level !== 'ok') sentence.textContent = t(STATUS_LONG[level]);
}

export function installStatusTicker() {
  tickStatusSentence();
  setInterval(tickStatusSentence, 1_000);
}
