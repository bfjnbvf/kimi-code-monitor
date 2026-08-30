/**
 * 会话域
 *
 * 职责边界：
 * - 会话身份（sessionId/token）、快照拉取、本地按会话汇总恢复、同页会话缓存。
 * - startSession 编排：断旧连接 → 状态归位 → 快照裁决 → 放行 WS。
 * - 面板状态写 panel-state.js，渲染调 render.js，宠物时钟调 pet-panel.js；
 *   WS 连接对象由 content.js 装配后通过 initSession 注入（不反向 import）。
 */

import { normalizeUsage, toNonNegativeInteger, totalInputTokens } from '../metrics.js';
import * as KimiCliUsage from '../cli-usage.js';
import { panel, clearSessionHistory, resetMetrics } from './panel-state.js';
import { toNumber, PET_ANSWER_STATUSES, rcApiPrefix, isRemoteControl, localApiAuthHeaders } from './utils.js';
import { renderAll, setAgentStatus, resetAgentStatusThrottle } from './render.js';
import {
  petCancelTurn,
  petClockTick,
  getPetStatusSince,
  setPetStatusSince
} from './pet-panel.js';

const { metrics, sessionSamples, turnDurations, agentTotals, sessionAgentOrder, agentTopModels, activeSubagents } = panel;

// 会话身份与请求代际（切换会话时作废旧请求）
let currentSessionId = '';
let currentToken = '';
let sessionRequestId = 0;
let sessionSnapshotPending = false;

// 同页切换会话的面板状态缓存：切走存档、切回瞬时恢复（数值、折线、计时连续）。
// 只活在页面内存里；单会话约 2-3KB，上限 30 个会话，超出淘汰最久未访问的。
const PANEL_SESSION_CACHE_LIMIT = 30;
const panelSessionCache = new Map();
let restoredPetStatusSince = 0;

let deps = {
  isDisposed: () => false,
  conn: null
};

export function initSession(nextDeps) {
  deps = { ...deps, ...nextDeps };
}

export function getCurrentSessionId() {
  return currentSessionId;
}

export function getSessionToken() {
  return currentToken;
}

export function setSessionToken(next) {
  currentToken = next;
}

export function isSnapshotPending() {
  return sessionSnapshotPending;
}

// 页面销毁时让所有在途请求过期（content.js dispose 调用）
export function invalidateSession() {
  sessionRequestId += 1;
  sessionSnapshotPending = false;
}

// 空壳快照（忙碌会话）或拉取失败时的本地恢复：CLI 扫描的按会话汇总做底，
// 之后的实时 WS 事件在其上累计——底数只含扫描时刻之前的记录，不双算。
function applySessionSeed(seed) {
  metrics.inputTokens = Math.max(
    0,
    toNonNegativeInteger(seed.input) - toNonNegativeInteger(seed.cacheRead)
  );
  metrics.outputTokens = toNonNegativeInteger(seed.output);
  metrics.cacheReadTokens = toNonNegativeInteger(seed.cacheRead);
  metrics.cacheCreationTokens = 0;

  // 按代理拆分：主代理置顶，子代理按最早记录时间排序；模型取 token 权重最高者
  Object.keys(agentTotals).forEach((key) => delete agentTotals[key]);
  sessionAgentOrder.length = 0;
  Object.keys(agentTopModels).forEach((key) => delete agentTopModels[key]);
  const agents = seed.agents && typeof seed.agents === 'object' ? seed.agents : {};
  const names = Object.keys(agents).sort((a, b) => {
    if (a === 'main') return -1;
    if (b === 'main') return 1;
    return (agents[a].firstAt || 0) - (agents[b].firstAt || 0);
  });
  for (const name of names.length ? names : ['main']) {
    const entry = agents[name];
    agentTotals[name] = {
      inputTokens: Math.max(
        0,
        toNonNegativeInteger(entry?.input) - toNonNegativeInteger(entry?.cacheRead)
      ),
      outputTokens: toNonNegativeInteger(entry?.output),
      cacheReadTokens: toNonNegativeInteger(entry?.cacheRead),
      cacheCreationTokens: 0
    };
    sessionAgentOrder.push(name);
    // config.update 的 modelAlias 是解析后的真实模型名（子代理的 usage 记录只有占位符）
    const alias = typeof entry?.modelAlias === 'string' ? entry.modelAlias : '';
    const models = entry?.models && typeof entry.models === 'object' ? entry.models : {};
    const top = Object.entries(models).sort((x, y) => y[1] - x[1])[0];
    if (alias || top) agentTopModels[name] = alias || top[0];
  }
}

async function readSessionSeed(targetSessionId) {
  if (deps.isDisposed()) return null;
  const stored = await chrome.storage.local.get(KimiCliUsage.SESSIONS_STORAGE_KEY);
  return stored[KimiCliUsage.SESSIONS_STORAGE_KEY]?.[targetSessionId] || null;
}

// 只补按代理拆分（不清空服务端已给的总量）：快照没有 agents 维度
async function seedAgentsFromScan(targetSessionId) {
  if (deps.isDisposed()) return;
  try {
    const seed = await readSessionSeed(targetSessionId);
    if (!seed?.agents || targetSessionId !== currentSessionId) return;
    const keep = { ...metrics };
    applySessionSeed(seed);
    metrics.inputTokens = keep.inputTokens;
    metrics.outputTokens = keep.outputTokens;
    metrics.cacheReadTokens = keep.cacheReadTokens;
    metrics.cacheCreationTokens = keep.cacheCreationTokens;
    renderAll();
  } catch (error) {
    // 读取失败不影响主显示
  }
}

async function restoreSessionFromScan(targetSessionId, stale) {
  if (deps.isDisposed()) return;
  try {
    const seed = await readSessionSeed(targetSessionId);
    if (stale()) return;
    if (seed) {
      applySessionSeed(seed);
      sessionSamples.length = 0;
      turnDurations.length = 0;
      renderAll();
    } else {
      resetMetrics();
      renderAll();
    }
  } catch (error) {
    if (!stale()) {
      resetMetrics();
      renderAll();
    }
  }
}

// 轮次结束后台重扫完成：本地按会话汇总已包含刚结束的轮次；空闲时用它刷新
// 面板底数（实时累计已被汇总覆盖，直接替换不双算），忙碌时跳过等下一轮。
export async function refreshSessionSeedFromScan() {
  if (deps.isDisposed() || !currentSessionId || panel.petTurnActive) return;
  if (PET_ANSWER_STATUSES.includes(metrics.agentStatus)) return;
  // await 期间可能已切换会话，旧会话的 seed 不能覆盖新会话面板
  const sid = currentSessionId;
  try {
    const seed = await readSessionSeed(sid);
    if (!seed || sid !== currentSessionId) return;
    applySessionSeed(seed);
    renderAll();
  } catch (error) {
    // 读取失败不影响现有显示
  }
}

async function loadSessionSnapshot(targetSessionId, targetToken, requestId, sessionChanged, hasLocalState = false) {
  // RC 中继回源时注入本机 token，页面侧空凭据也可拉快照
  if (deps.isDisposed() || !targetSessionId || (!targetToken && !isRemoteControl())) return;
  const stale = () =>
    requestId !== sessionRequestId || targetSessionId !== currentSessionId || targetToken !== currentToken;
  try {
    const response = await fetch(`${rcApiPrefix()}/api/v1/sessions/${encodeURIComponent(targetSessionId)}`, {
      headers: localApiAuthHeaders(targetToken),
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    // 新版接口返回 { code, data, msg }，旧版直接返回会话对象。
    const data = body?.data && typeof body.data === 'object' ? body.data : body;
    if (stale()) return;
    // 快照带 usage：以服务器累计为准
    const snapshotUsage = data?.usage ? normalizeUsage(data.usage) : null;
    // 服务端对忙碌中的会话返回全零 usage/last_seq 的空壳快照（实测），
    // 这种会话由本地按会话汇总恢复，服务器值不可信。
    const snapshotLooksUnavailable =
      snapshotUsage &&
      toNumber(data.last_seq) === 0 &&
      totalInputTokens(snapshotUsage) === 0 &&
      snapshotUsage.outputTokens === 0;
    if (snapshotUsage && !snapshotLooksUnavailable) {
      const usage = snapshotUsage;
      metrics.inputTokens = usage.inputTokens;
      metrics.outputTokens = usage.outputTokens;
      metrics.cacheReadTokens = usage.cacheReadTokens;
      metrics.cacheCreationTokens = usage.cacheCreationTokens;
      metrics.agentStatus = data.busy || data.main_turn_active ? 'thinking' : 'idle';
      // 游标只前进不回退：快照的 last_seq 可能早于已处理的实时事件
      const snapshotSeq = toNumber(data.last_seq);
      deps.conn.advanceCursors(snapshotSeq);
      // 有本地恢复（内存缓存/汇总）时样本与计时保持连续，不清空
      if (sessionChanged && !hasLocalState) {
        clearSessionHistory();
        // 服务端快照没有按代理拆分，用本地扫描的按代理汇总补齐子代理视图
        seedAgentsFromScan(targetSessionId);
      }
      renderAll();
      return;
    }
    metrics.agentStatus = data?.busy || data?.main_turn_active ? 'thinking' : 'idle';
    // 空壳快照：内存缓存已由 startSession 恢复时不动数据；否则用本地汇总做底
    if (sessionChanged && !hasLocalState) {
      await restoreSessionFromScan(targetSessionId, stale);
      return;
    }
    renderAll();
  } catch (error) {
    console.warn('[Kimi Status] 会话快照拉取失败，改由本地按会话汇总恢复', error);
    if (!stale() && sessionChanged) {
      if (hasLocalState) renderAll();
      else await restoreSessionFromScan(targetSessionId, stale);
    }
  }
}

// agent.status.updated：订阅后服务端会补推该会话最后一次 agent 状态，可能是滞留的
// working/thinking；开工状态只以快照 busy 标志与真实 turn 事件为准，轮次活动外只接受收工
export function handleAgentStatus(payload) {
  const status = payload.status || payload.agent_status;
  if (status === 'idle' || status === 'waiting') {
    deps.conn.setAgentWorkStatus('idle');
    return;
  }
  if (!panel.petTurnActive) return;
  if (status === 'thinking' || status === 'processing') deps.conn.setAgentWorkStatus('thinking');
  else if (status === 'running' || status === 'working') deps.conn.setAgentWorkStatus('thinking');
}

function cachePanelState(sid) {
  if (!sid) return;
  if (panelSessionCache.has(sid)) panelSessionCache.delete(sid);
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
    sessionAgentOrder: sessionAgentOrder.slice(),
    agentTopModels: { ...agentTopModels }
  });
  while (panelSessionCache.size > PANEL_SESSION_CACHE_LIMIT) {
    panelSessionCache.delete(panelSessionCache.keys().next().value);
  }
}

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
  sessionAgentOrder.length = 0;
  sessionAgentOrder.push(...cached.sessionAgentOrder);
  Object.keys(agentTopModels).forEach((key) => delete agentTopModels[key]);
  Object.assign(agentTopModels, cached.agentTopModels);
  // 计时起点在 setAgentStatus 之后由调用方恢复（状态切换会重置它）
  restoredPetStatusSince = cached.petStatusSince;
  return true;
}

export async function startSession(nextSessionId) {
  if (deps.isDisposed()) return;
  const requestId = ++sessionRequestId;
  sessionSnapshotPending = true;
  deps.conn.disconnect();
  const sessionChanged = nextSessionId !== currentSessionId;
  if (sessionChanged) {
    cachePanelState(currentSessionId);
    petCancelTurn();
    deps.conn.clearToolStatus();
    activeSubagents.clear();
    // 上一会话挂起的状态节流不能带到新会话，立即放行下一个状态
    resetAgentStatusThrottle();
    // 换会话：游标固定归零。空闲会话的历史重放由 ack 闸门控制（只进折线样本），
    // 面板数据由「快照 + 本地按会话汇总」恢复，WS 只接实时事件。
    deps.conn.resetCursors();
  }
  currentSessionId = nextSessionId;
  // RC 中继由云端鉴权，空凭据是正常状态，不阻断会话启动
  if (!currentSessionId || (!currentToken && !isRemoteControl())) {
    if (requestId === sessionRequestId) sessionSnapshotPending = false;
    resetMetrics();
    renderAll();
    return;
  }
  let hasLocalState = false;
  if (sessionChanged) {
    // 状态立即归位：同页切回过的会话恢复其缓存状态，否则先归空闲，
    // 数字则等快照/本地底数一次性替换，不再把上一会话的状态停在屏幕上
    hasLocalState = restorePanelState(nextSessionId);
    setAgentStatus(hasLocalState ? metrics.agentStatus : 'idle');
    if (hasLocalState) {
      // 恢复计时起点（petUpdateStatus 在状态切换时重置过它），计时保持连续
      setPetStatusSince(restoredPetStatusSince);
      petClockTick();
      renderAll();
    }
  }
  const targetToken = currentToken;
  try {
    await loadSessionSnapshot(nextSessionId, targetToken, requestId, sessionChanged, hasLocalState);
  } finally {
    // 旧请求结束不能解除新请求的闸门；只有当前请求可以放行 WebSocket。
    if (requestId === sessionRequestId) sessionSnapshotPending = false;
  }
  if (
    !deps.isDisposed() &&
    requestId === sessionRequestId &&
    currentSessionId === nextSessionId &&
    currentToken === targetToken
  ) deps.conn.connect();
}
