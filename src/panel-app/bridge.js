/**
 * 面板数据总线（window.__kcm.push 队列 + 消息分发）
 *
 * 桌面补丁注入模式的数据入口，推送方两类：
 * - direct.js：kap-server 的 WS 事件、REST 轮询与外部账户直连抓取（本文件同目录）；
 * - loader.js：usage-daily.js / wallet.js 落盘快照（安装器预填 + 技能刷新）。
 * msg 形如 { v: 1, type, ... }：
 *   - { type: 'quota', quota: { limit5h: { usedRatio, resetAt }, limit7d: { ... } } }
 *     usedRatio 是 0~1 用量比（×100 后进 updateProgress）；resetAt 为 ISO 时间
 *     （parseResetTime 后进 updateResetText）。可选 wallet 字段透传 updateBalance。
 *   - { type: 'event', event }：kap-server 的 WS 消息（type/payload/agent_id…），
 *     按 websocket-session.js 的实时分支翻译成面板状态（游标/重连/去重不管）。
 *   - { type: 'usageDaily', daily, hourly, sessions, secondaryModel }：CLI 长期统计
 *     （wire.jsonl 全量扫描）。daily/hourly 与页内按天积累（accumulate.js）取大合并后
 *     写 panel.usageDailyCache；sessions 是按会话（代理 × 模型）汇总，切会话时做底数。
 *   - { type: 'status', status: 'idle' | 'working' | 'waiting' | 'offline' }：
 *     整体状态灯与宠物联动。
 *   - { type: 'external', providers, unsupported, fetchedAt }：外部账户余额，
 *     direct.js 直连客户端 provider 配置与厂商接口的抓取结果，直写
 *     panel.externalProviders 后重绘。
 *   - { type: 'session', sid, snapshot?: { usage, busy } }：切换当前会话（跟随桌面端
 *     SPA 路由焦点）——切走先存档面板状态，切回瞬时恢复；服务器快照只在
 *     usage 非零时当底数（kap 目前恒返回全零，见 usableSnapshotUsage）。
 *   - 可选 sessionId 字段（任意消息上）：标记当前会话 id（宠物轮次归属用）。
 *
 * push 早于面板装配完成时先入队，markBridgeReady 后按序补发。
 */

import { normalizeUsage, toNonNegativeInteger, totalInputTokens } from '../metrics.js';
import { noteStepUsage, mergeDaily, hasAccumulated } from './accumulate.js';
import { summarizeStatus, STATUS_LONG } from './status-copy.js';
import { t } from '../i18n.js';
import {
  panel,
  noteAgentUsage,
  pushStepSample,
  recordTurnDuration,
  registerSessionAgent,
  resetMetrics,
  seedSessionAgent,
  markLastSampleTurnEnd
} from '../content/panel-state.js';
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
import {
  petBeginTurn,
  petCompleteTurn,
  petClockTick,
  getPetStatusSince,
  setPetStatusSince
} from '../content/pet-panel.js';
import { parseResetTime, PET_ANSWER_STATUSES } from '../content/utils.js';

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
// 已消费到的事件序号（断线补发/重放去重用，切会话归零）
let lastUsageSeq = 0;

// 面板状态的常用引用（身份在页面生命周期内稳定，见 panel-state.js）
const { metrics, sessionSamples, turnDurations, agentTotals, sessionAgentOrder } = panel;

// 同页会话缓存：切走存档、切回瞬时恢复（数值、折线、计时连续）。只活在页面内存里；
// 单会话约 2-3KB，上限 30 个，超出淘汰最久未访问的。
// 与扩展侧同一策略（content/session.js 的 panelSessionCache）——两边行为要对齐，
// 改动这里时顺手看一眼那边。
const PANEL_SESSION_CACHE_LIMIT = 30;
const panelSessionCache = new Map();
let restoredPetStatusSince = 0;

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

  // 落进「代理 × 模型」：事件自带模型名就用它（主代理中途换过模型时各归各行），
  // 不带就记到该代理的当前模型；代理合计同步累加，两者不会各记一份
  noteAgentUsage(agentId, payload.model || payload.modelAlias, usage);

  pushStepSample(payload);
  renderAll();
}

// 重放事件（订阅应答之前到达的历史事件）只登记代理与模型、不进任何计数器：
// 面板数字已由本地汇总/同页缓存做底，重放再累加就是双算。代理行本身由底数给出，
// 这里只补「这个代理出现在本会话里」，与扩展侧 websocket-session.js 的
// replayIsHistory 分支同一口径。
function noteReplayedStep(payload, agentId) {
  registerSessionAgent(agentId);
  const model = payload.model || payload.modelAlias;
  if (typeof model === 'string' && model.trim()) panel.agentModelHint[agentId] = model.trim();
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
  const seq = Number(message.seq);
  const hasSeq = Number.isFinite(seq);

  // 重放（订阅应答之前到达的事件）：整段历史不进任何计数器——面板数字已由
  // 本地汇总与同页缓存做底，重放再累加就是双算，只补「哪些代理来过」与折线样本。
  // 游标非 0（断线期间漏掉的那段）是真正的缺口，照常计入，按序号去重防重复累加。
  // 口径与扩展侧 websocket-session.js 的重放分支一致。
  if (message.kcmReplay === true) {
    if (message.type === 'turn.step.completed') {
      const replayAgent = eventAgentId(message, payload);
      if (message.kcmReplayHistory === true) {
        noteReplayedStep(payload, replayAgent);
        if (sessionSamples.length === 0) pushStepSample(payload);
      } else if (!hasSeq || seq > lastUsageSeq) {
        handleStepCompleted(payload, replayAgent);
      }
      if (hasSeq) lastUsageSeq = Math.max(lastUsageSeq, seq);
    } else if (message.type === 'turn.ended' || message.type === 'turn.completed') {
      const replayDuration = Number(payload.durationMs ?? payload.duration_ms ?? payload.duration);
      if (Number.isFinite(replayDuration) && replayDuration > 0) recordTurnDuration(replayDuration);
    }
    renderAll();
    return;
  }

  switch (message.type) {
    case 'turn.started':
      clearToolStatus();
      petBeginTurn();
      setAgentStatus('thinking');
      break;
    case 'turn.step.started':
      setAgentWorkStatus(isSubagentEvent(message, payload) ? 'subagent' : 'thinking');
      break;
    case 'turn.step.completed': {
      const stepAgent = eventAgentId(message, payload);
      // 断线补发可能重放已被实时处理过的 step，按序号去重（volatile 帧复用序号，不参与）
      if (!hasSeq || message.volatile === true || seq > lastUsageSeq) {
        handleStepCompleted(payload, stepAgent);
        if (hasSeq && message.volatile !== true) lastUsageSeq = seq;
      }
      setAgentWorkStatus(isSubagentEvent(message, payload) ? 'subagent' : 'thinking');
      break;
    }
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
  // 按会话（代理 × 模型）汇总：切会话时的本地底数。技能重扫后文件内容变化，
  // 下一轮轮询就会把新汇总推上来
  panel.cliSessionSummary = msg.sessions && typeof msg.sessions === 'object' ? msg.sessions : {};
  panel.secondaryModelName = typeof msg.secondaryModel === 'string' ? msg.secondaryModel : '';
  panel.cliUsageConnected = msg.connected !== false;
  // loader 的状态行读这个标记区分「文件已载入」与「已进渲染层」
  try {
    globalThis.__kcmDebug = { ...globalThis.__kcmDebug, usageDailyOk: true };
  } catch (error) {
    // 忽略
  }
  refreshDailyChart();
  // 重扫后的新汇总：只给「面板还没有数字」的当前会话补底。已有实时累计就不动——
  // 实时数字里含扫描之后的增量，覆盖就把那段丢了。
  if (metrics.inputTokens + metrics.outputTokens + metrics.cacheReadTokens === 0
    && applySessionSeed(currentSessionId)) {
    renderAll();
  }
}

/** 本地按会话汇总（usage-daily.js 的 sessions 字段）→ 面板底数。
 *  agentsOnly：总量已有来源（服务器快照）时只补「代理 × 模型」的拆分。 */
function applySessionSeed(sid, { agentsOnly = false } = {}) {
  const seed = panel.cliSessionSummary?.[sid];
  if (!seed || typeof seed !== 'object') return false;
  if (!agentsOnly) {
    // 汇总的 input 含缓存读（与文件扫描同口径），面板的 inputTokens 只记非缓存
    metrics.inputTokens = Math.max(
      0,
      toNonNegativeInteger(seed.input) - toNonNegativeInteger(seed.cacheRead)
    );
    metrics.outputTokens = toNonNegativeInteger(seed.output);
    metrics.cacheReadTokens = toNonNegativeInteger(seed.cacheRead);
    metrics.cacheCreationTokens = 0;
  }
  // 主代理置顶，子代理按最早记录时间排序；每个代理下的模型展开成多行
  const agents = seed.agents && typeof seed.agents === 'object' ? seed.agents : {};
  const names = Object.keys(agents).sort((a, b) => {
    if (a === 'main') return -1;
    if (b === 'main') return 1;
    return (agents[a]?.firstAt || 0) - (agents[b]?.firstAt || 0);
  });
  for (const name of names.length ? names : ['main']) {
    seedSessionAgent(name, agents[name]?.models);
  }
  return true;
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

/** 服务器快照的 usage 是否可用：全零一律当「没拿到」。
 *  kap 的 /api/v1/sessions/<id> 目前恒返回全零 usage（2026-09-21 实测：连
 *  busy 且 last_seq 在推进的会话也是 0），拿它当底数等于把面板清零。
 *  真正没用过的新会话同样是全零，所以这里不区分二者——都交给缓存与后续实时事件。
 *  口径提醒：REST 的 input_tokens 是否「含缓存」尚未验证过（该字段至今恒 0），
 *  等后端开始供货时要用 wire.jsonl 的同一条记录核对，避免缓存被重复计入。 */
function usableSnapshotUsage(snapshot) {
  const raw = snapshot?.usage;
  if (!raw || typeof raw !== 'object') return null;
  const usage = normalizeUsage(raw);
  return totalInputTokens(usage) + usage.outputTokens > 0 ? usage : null;
}

/** 切走时存档当前会话的面板状态（重复访问移到最新，超出上限淘汰最久未访问的） */
function cachePanelState(sid) {
  if (!sid || sid === DEFAULT_SESSION_ID) return;
  panelSessionCache.delete(sid);
  panelSessionCache.set(sid, {
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    cacheReadTokens: metrics.cacheReadTokens,
    cacheCreationTokens: metrics.cacheCreationTokens,
    lastDuration: metrics.lastDuration,
    agentStatus: metrics.agentStatus,
    petStatusSince: getPetStatusSince(),
    sessionSamples: sessionSamples.slice(),
    turnDurations: turnDurations.slice(),
    agentTotals: JSON.parse(JSON.stringify(agentTotals)),
    // 按「代理 × 模型」的拆分与当前模型标记一起存：切回来时子代理各行的数字、
    // 各行的模型名都能原样回来（只有合计没法还原出哪一行是哪个模型）
    agentModels: JSON.parse(JSON.stringify(panel.agentModels)),
    agentModelHint: { ...panel.agentModelHint },
    sessionAgentOrder: sessionAgentOrder.slice()
  });
  while (panelSessionCache.size > PANEL_SESSION_CACHE_LIMIT) {
    panelSessionCache.delete(panelSessionCache.keys().next().value);
  }
}

/** 切回时恢复该会话的面板状态；没有存过返回 false */
function restorePanelState(sid) {
  const cached = panelSessionCache.get(sid);
  if (!cached) return false;
  panelSessionCache.delete(sid);
  panelSessionCache.set(sid, cached); // 移到最新
  metrics.inputTokens = cached.inputTokens;
  metrics.outputTokens = cached.outputTokens;
  metrics.cacheReadTokens = cached.cacheReadTokens;
  metrics.cacheCreationTokens = cached.cacheCreationTokens;
  metrics.lastDuration = cached.lastDuration;
  metrics.agentStatus = cached.agentStatus;
  // 复制再挂到 live 数组：后续 push/shift 不能回写缓存条目
  sessionSamples.length = 0;
  sessionSamples.push(...cached.sessionSamples);
  turnDurations.length = 0;
  turnDurations.push(...cached.turnDurations);
  Object.keys(agentTotals).forEach((key) => delete agentTotals[key]);
  Object.assign(agentTotals, cached.agentTotals);
  Object.keys(panel.agentModels).forEach((key) => delete panel.agentModels[key]);
  Object.assign(panel.agentModels, cached.agentModels || {});
  Object.keys(panel.agentModelHint).forEach((key) => delete panel.agentModelHint[key]);
  Object.assign(panel.agentModelHint, cached.agentModelHint || {});
  sessionAgentOrder.length = 0;
  sessionAgentOrder.push(...cached.sessionAgentOrder);
  // 计时起点由调用方在 setAgentStatus 之后恢复（状态切换会重置它）
  restoredPetStatusSince = cached.petStatusSince;
  return true;
}

// 当前会话切换（direct.js 按 SPA 路由焦点推送）：切走先存档、切回瞬时恢复，
// 服务器快照只当「非零才可信」的底数——三条来源的优先级写在 handleSessionSwitch 里。
function handleSessionSwitch(msg) {
  const sid = typeof msg.sid === 'string' ? msg.sid : '';
  if (!sid) return;
  if (sid === currentSessionId) {
    // 同一会话的重复焦点（离开会话页又回来 / 路由抖动）：数字不动——这个会话从没
    // 被切走，实时事件一直在往里累计，重拉到的快照只会更旧。只取「收工」信号
    // 对齐状态灯（busy 为真可能是滞留状态，与 work_changed 同策略）。
    if (msg.snapshot?.busy === false) setAgentStatus('idle');
    return;
  }

  // ① 同页缓存：把切走的会话存起来（切回时数值、折线样本、上轮耗时、
  //    按代理拆分、宠物计时都能接着上，不用等任何人给数据）
  cachePanelState(currentSessionId);
  currentSessionId = sid;
  lastUsageSeq = 0;
  clearToolStatus();
  resetMetrics();
  const restored = restorePanelState(sid);

  // ② 服务器快照做底：只在 usage 非零时采用——它比缓存新，可以覆盖。
  //    快照只有总量、没有代理维度，所以按代理 × 模型的拆分仍由本地汇总补
  const usage = usableSnapshotUsage(msg.snapshot);
  if (usage) {
    panel.metrics.inputTokens = usage.inputTokens;
    panel.metrics.outputTokens = usage.outputTokens;
    panel.metrics.cacheReadTokens = usage.cacheReadTokens;
    panel.metrics.cacheCreationTokens = usage.cacheCreationTokens;
    if (!applySessionSeed(sid, { agentsOnly: true })) {
      // 没有本地汇总时，代理维度只能给主代理一行（合计取快照）
      registerSessionAgent('main');
      const mainTotals = panel.agentTotals.main;
      mainTotals.inputTokens = usage.inputTokens;
      mainTotals.outputTokens = usage.outputTokens;
      mainTotals.cacheReadTokens = usage.cacheReadTokens;
      mainTotals.cacheCreationTokens = usage.cacheCreationTokens;
    }
  } else if (!restored) {
    // ③ 本地汇总做底（wire.jsonl 扫描，装补丁时预填、技能刷新时更新）：
    //    没有同页缓存、快照又不可用时，这是空闲会话唯一的数字来源
    //    ——kap 的快照 usage 恒为全零（见 usableSnapshotUsage）
    applySessionSeed(sid);
  }

  // ③ 状态：快照的 busy 是独立且可信的字段（usage 为 0 时也照样给），有它就用它；
  //    否则沿用缓存里的状态，随后的 WS 事件（含收工信号）会把它纠正过来
  const status = typeof msg.snapshot?.busy === 'boolean'
    ? (msg.snapshot.busy ? 'thinking' : 'idle')
    : (restored ? panel.metrics.agentStatus : 'idle');
  setAgentStatus(status);
  // 恢复宠物计时起点：状态切换会重置它，所以必须放在 setAgentStatus 之后
  if (restored && PET_ANSWER_STATUSES.includes(status)) {
    setPetStatusSince(restoredPetStatusSince);
    petClockTick();
  }

  renderAll();
  renderPetStats();
}

// 外部账户：唯一来源是 direct.js 的实时抓取（面板直连客户端自己的 provider
// 配置与厂商余额接口，每 60 秒一轮）。没有落盘快照、没有第二个来源，
// 所以这里不需要任何优先级判定——谁来消息就是最新结果。
// 数据形状与扩展 background/external.js 的 providers 一致
// （{id, name, keyTail, kind, total, granted, paid, currency, windows, plan, error,
//   fetchedAt}）；接口失败时 direct.js 沿用该家上次成功的数值并带上 error，
// 渲染层据此显示「N 分钟前 ¥6.70」而不是清空。
function handleExternal(msg) {
  panel.externalProviders = Array.isArray(msg.providers) ? msg.providers : [];
  panel.externalUnsupported = Array.isArray(msg.unsupported) ? msg.unsupported : [];
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
      globalThis.__kcmDebug = {
        ...globalThis.__kcmDebug,
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
  globalThis.__kcm = {
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
  const d = globalThis.__kcmDebug || {};
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
