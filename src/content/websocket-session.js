/**
 * WebSocket 会话管理
 *
 * 职责边界：
 * - 维护与 Kimi 后端的 WebSocket 连接、重连、握手与消息路由。
 * - 真正的跨域动作（DOM/宠物回调）通过依赖注入与 content.js 交互；
 *   面板状态直接读取 panel-state.js，不再走回调。
 */

import { normalizeUsage } from '../metrics.js';
import { setAgentStatus, renderAll } from './render.js';
import { onTurnEnded } from '../session-rename/rename-content.js';
import { petBeginTurn, petCompleteTurn } from './pet-panel.js';
import { toNumber } from './utils.js';
import { t } from '../i18n.js';
import {
  panel,
  registerSessionAgent,
  pushStepSample,
  pushReplayedTurnDuration,
  markLastSampleTurnEnd,
  recordTurnDuration
} from './panel-state.js';

const WS_CONNECTING_TIMEOUT_MS = 10_000;
const WS_MAX_RECONNECT_ATTEMPTS = 10;
const WS_RECONNECT_PROBE_MS = 60_000;
const WS_RECONNECT_DELAY_MS = 3_000;
const TOOL_STATUS_MIN_MS = 1_500;

export function createWebSocketSession(deps) {
  // 连接状态
  let ws = null;
  let wsConnectingSince = 0;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let helloWatchdog = null;

  // 订阅重放闸门
  let awaitingAck = false;
  let ackWatchdog = null;
  // 下次 client_hello 使用的游标：会话切换后固定为 0（换取历史重放来填充折线样本），
  // ack 之后更新为当前水位（断线重连时只补发未见事件）
  let subscriptionCursor = 0;
  let replayIsHistory = false;
  let replaySamplesExpected = false;

  // durable 与 usage/turn 游标
  let lastSeq = 0;
  // 快照失败时这两个游标只负责避免当前页面已处理事件再次计入 UI，不参与 client_hello。
  // 实测：服务端对过期游标只回 resync_required，从不补发历史事件，
  // 因此会话数据恢复完全依赖「快照 + 本地按会话汇总」，WS 只接实时事件。
  let lastUsageSeq = -1;
  let lastTurnSeq = -1;

  // 工具调用可能与 step / agent 状态事件交错；在结果返回前保持「执行中」，
  // 避免刚显示就被紧随其后的 running / thinking 覆盖。
  let activeToolCalls = 0;
  let toolStatusUntil = 0;
  let toolStatusTimer = null;
  let deferredWorkStatus = 'thinking';

  // 服务器错误日志节流
  let lastServerErrorLogAt = 0;

  const {
    isDisposed,
    getToken,
    getSessionId,
    setConnectionHint,
    handleAgentStatus,
    scheduleCliUsageRefresh
  } = deps;
  const { metrics, sessionSamples, activeSubagents } = panel;

  function handleStepCompleted(payload, agentId = 'main') {
    const usage = normalizeUsage(payload.usage || payload.token_usage);

    metrics.inputTokens += usage.inputTokens;
    metrics.outputTokens += usage.outputTokens;
    metrics.cacheReadTokens += usage.cacheReadTokens;
    metrics.cacheCreationTokens += usage.cacheCreationTokens;

    registerSessionAgent(agentId);
    const totals = panel.agentTotals[agentId];
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.cacheReadTokens += usage.cacheReadTokens;
    totals.cacheCreationTokens += usage.cacheCreationTokens;

    pushStepSample(payload);
    renderAll();
  }

  function clearHelloWatchdog() {
    if (helloWatchdog) clearTimeout(helloWatchdog);
    helloWatchdog = null;
  }

  function connectWebSocket() {
    if (isDisposed()) return;
    const token = getToken();
    const sessionId = getSessionId();
    if (!token || !sessionId) return;
    if (ws) {
      // 已有连接（或正在建立）：CONNECTING 状态超时未打开视为假死，主动关闭后由 onclose 重连
      if (ws.readyState === WebSocket.CONNECTING && Date.now() - wsConnectingSince > WS_CONNECTING_TIMEOUT_MS) {
        setConnectionHint(t('WebSocket 连接建立超时，正在重试…'));
        try { ws.close(); } catch {}
      }
      return;
    }
    // 连续重试达到上限后改为低频探测，避免无限重连
    if (reconnectAttempts >= WS_MAX_RECONNECT_ATTEMPTS) {
      setConnectionHint(t('WebSocket 连续重连失败，已暂停自动重连'));
      scheduleReconnect(true);
      return;
    }
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}/api/v1/ws?client_id=kimi-statusbar`;

    try {
      ws = new WebSocket(url, [`kimi-code.bearer.${token}`]);
      wsConnectingSince = Date.now();
    } catch (error) {
      console.warn('[Kimi Status] WebSocket 创建失败', error);
      reconnectAttempts += 1;
      scheduleReconnect();
      return;
    }

    // server_hello 看门狗：连接 OPEN 但 hello 永不到达（半开连接）时主动断开走重连
    clearHelloWatchdog();
    helloWatchdog = setTimeout(() => {
      helloWatchdog = null;
      if (ws) {
        setConnectionHint(t('等待 server_hello 超时，正在重连…'));
        try {
          ws.close();
        } catch (error) {
          // 忽略，onclose 会接管
        }
      }
    }, 10_000);

    ws.onmessage = (event) => {
      try {
        handleWsMessage(JSON.parse(event.data));
      } catch (error) {
        console.warn('[Kimi Status] 忽略无法解析的 WebSocket 消息', error);
      }
    };

    ws.onclose = (event) => {
      clearHelloWatchdog();
      ws = null;
      // 断线统一显示「未连接」，后台退避重连；重连成功后由 server_hello 恢复
      setAgentStatus('offline');
      setConnectionHint(t('WebSocket 已断开（{code}{reason}），正在重连…', { code: event.code, reason: event.reason ? `: ${event.reason}` : '' }));
      reconnectAttempts += 1;
      scheduleReconnect();
    };

    ws.onerror = () => setConnectionHint(t('WebSocket 连接失败'));
  }

  function scheduleReconnect(isProbe = false) {
    if (isDisposed() || reconnectTimer) return;
    if (!isProbe && reconnectAttempts >= WS_MAX_RECONNECT_ATTEMPTS) {
      setConnectionHint(t('WebSocket 连续重连失败，已暂停自动重连'));
      scheduleReconnect(true);
      return;
    }
    const exponentialDelay = isProbe
      ? WS_RECONNECT_PROBE_MS
      : Math.min(
          30_000,
          WS_RECONNECT_DELAY_MS * (2 ** Math.min(reconnectAttempts, 4))
        );
    const delay = isProbe ? exponentialDelay : Math.round(exponentialDelay * (0.8 + Math.random() * 0.4));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWebSocket();
    }, delay);
  }

  function clearAckWatchdog() {
    if (ackWatchdog) clearTimeout(ackWatchdog);
    ackWatchdog = null;
  }

  function sendFrame(frame) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  }

  function sendClientHello() {
    const sessionId = getSessionId();
    awaitingAck = true;
    replayIsHistory = subscriptionCursor === 0;
    // 已有样本（内存缓存恢复 / 断线重连）时重放不再进样本，避免重复
    replaySamplesExpected = sessionSamples.length === 0;
    // 个别服务端可能不回 ack：超时强制放行，避免实时事件被永久抑制
    clearAckWatchdog();
    ackWatchdog = setTimeout(() => {
      ackWatchdog = null;
      awaitingAck = false;
    }, 3_000);
    sendFrame({
      type: 'client_hello',
      id: `ksb-${Date.now()}`,
      payload: {
        client_id: 'kimi-statusbar',
        subscriptions: [sessionId],
        cursors: { [sessionId]: { seq: subscriptionCursor } }
      }
    });
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
    // deferredWorkStatus 保留 setAgentWorkStatus 写入的最新工作状态，
    // 工具锁释放后直接用它恢复；默认值由 turn.started/turn.ended 的 clearToolStatus 重置
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

  // 事件的子代理身份：step/delta 事件在 message 或 payload 上带 agent_id/agentId，
  // subagent.* 生命周期事件带 payload.subagentId
  function isSubagentEvent(message, payload) {
    const id =
      message.agent_id ?? payload.agent_id ?? payload.agentId ?? payload.subagentId;
    return Boolean(id) && id !== 'main';
  }

  // 事件归属的代理 id：缺省视为主代理
  function eventAgentId(message, payload) {
    return (
      message.agent_id ?? payload.agent_id ?? payload.agentId ?? payload.subagentId ?? 'main'
    );
  }

  function handleWsMessage(message) {
    if (isDisposed()) return;
    const sessionId = getSessionId();
    // 事件必须属于当前会话；server_hello/ping/ack 等不带 session_id，直接放行
    if (message.session_id && message.session_id !== sessionId) return;
    // 归一化 durable 序号：非有限值视为无效，不更新任何游标
    const seq = Number.isFinite(Number(message.seq)) ? Number(message.seq) : null;

    if (message.type === 'server_hello') {
      clearHelloWatchdog();
      reconnectAttempts = 0;
      setConnectionHint(t('Kimi Status 已连接'));
      // 重连成功后先回到空闲，后续事件（含游标补发的）会把状态修正过来
      if (metrics.agentStatus === 'offline') {
        setAgentStatus('idle');
      }
      sendClientHello();
      return;
    }

    if (message.type === 'ping') {
      sendFrame({ type: 'pong', payload: { nonce: message.payload?.nonce } });
      return;
    }

    // 订阅应答：重放边界。ack / resync_required 之后到达的才是实时事件
    if (message.type === 'ack' || message.type === 'resync_required') {
      clearAckWatchdog();
      awaitingAck = false;
      subscriptionCursor = lastSeq;
      renderAll();
      return;
    }

    // 重放事件（ack 之前到达）：不改状态、不播 Stars。
    // 历史重放（订阅游标为 0）只进折线样本，面板计数已由快照/本地汇总恢复；
    // 断线补发（游标非 0）是页面加载后的新事件，汇总未含，照常计数。
    if (awaitingAck) {
      const replaySeq = Number(message.seq);
      // 重连重放去重：ack 之后 subscriptionCursor 不随实时事件推进，重连时服务端
      // 会按陈旧游标重放已被实时处理过的事件。先捕获推进前的游标用于判定
      // （下面 Math.max 才推进水位），重放过的 step/turn 不再计入。
      const prevUsageSeq = lastUsageSeq;
      const prevTurnSeq = lastTurnSeq;
      if (Number.isFinite(replaySeq)) {
        lastSeq = Math.max(lastSeq, replaySeq);
        lastUsageSeq = Math.max(lastUsageSeq, replaySeq);
        lastTurnSeq = Math.max(lastTurnSeq, replaySeq);
      }
      const replayPayload = message.payload || {};
      if (message.type === 'turn.step.completed') {
        const replayAgent = eventAgentId(message, replayPayload);
        if (replayIsHistory) {
          // 历史重放：只进折线样本并登记代理顺序，不进任何计数器
          registerSessionAgent(replayAgent);
          if (replaySamplesExpected) pushStepSample(replayPayload);
        } else if (!Number.isFinite(replaySeq) || replaySeq > prevUsageSeq) {
          // 断线补发只累计游标之后的新 step，重放已实时处理的 step 会双算 token
          handleStepCompleted(replayPayload, replayAgent);
        }
      } else if (message.type === 'turn.ended' || message.type === 'turn.completed') {
        // 轮次结束同理按 lastTurnSeq 去重：重放已处理的轮次不重复记耗时样本、
        // 不再触发用量重扫
        if (!Number.isFinite(replaySeq) || replaySeq > prevTurnSeq) {
          pushReplayedTurnDuration(replayPayload);
          if (!replayIsHistory) scheduleCliUsageRefresh();
        }
      }
      return;
    }

    // volatile 帧复用当前 durable watermark；相同 seq 不代表重复，不能被游标过滤。
    // 只有 durable 事件推进/校验 lastSeq，client_hello 的补发游标也只认 durable 序号。
    if (message.seq != null && message.volatile !== true) {
      if (seq != null) {
        if (seq <= lastSeq) return;
        lastSeq = seq;
      }
    }
    const payload = message.payload || {};

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
        // 快照失败后 cursor=0 会补发旧事件；当前页面已处理过的 step 只用于恢复状态，
        // 不再重复累加面板数值。真正缺失的新 step 仍会正常进入。
        if (seq == null || seq > lastUsageSeq) {
          handleStepCompleted(payload, eventAgentId(message, payload));
          if (seq != null) lastUsageSeq = seq;
        }
        // step 之间的间隙通常在执行工具或等待模型，主代理统一显示「思考中」；
        // 子代理的 step 单独显示「子代理」
        setAgentWorkStatus(isSubagentEvent(message, payload) ? 'subagent' : 'thinking');
        break;
      case 'thinking.delta':
        // 主代理的推理流；子代理的 delta 不改变「子代理」显示
        if (!isSubagentEvent(message, payload) && deferredWorkStatus !== 'thinking') {
          setAgentWorkStatus('thinking');
        }
        break;
      case 'assistant.delta':
        // 主代理正在输出回复正文
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
          activeSubagents.add(String(subId));
        }
        setAgentWorkStatus('subagent');
        break;
      }
      case 'subagent.completed':
      case 'subagent.failed': {
        const subId = payload.subagentId ?? payload.agentId;
        if (subId) activeSubagents.delete(String(subId));
        // 子代理结束后主代理通常继续本轮；后续事件会修正具体状态
        setAgentWorkStatus('thinking');
        break;
      }
      case 'tool.call.started':
        // 当前服务通常在 1–20ms 内连续发 started/result；保留最短可见时长供人眼识别。
        beginToolStatus();
        break;
      case 'tool.result':
        finishToolStatus();
        break;
      case 'turn.ended':
      case 'turn.completed': {
        const turnSequence = seq;
        const alreadyRecorded = turnSequence != null && turnSequence <= lastTurnSeq;
        const duration = toNumber(payload.durationMs ?? payload.duration_ms ?? payload.duration);
        if (!alreadyRecorded && duration > 0) {
          recordTurnDuration(duration);
        }
        if (turnSequence != null) lastTurnSeq = Math.max(lastTurnSeq, turnSequence);
        if (!alreadyRecorded) {
          clearToolStatus();
          setAgentStatus('idle');
          // 折线图：本轮最后一个 step 样本加常驻大节点，区分轮内调用与整轮结束
          markLastSampleTurnEnd();
          petCompleteTurn();
          // 会话智能命名（session-rename/rename-content.js）：开关关闭时内部直接返回
          onTurnEnded(sessionId);
        }
        renderAll();
        scheduleCliUsageRefresh();
        break;
      }
      case 'event.session.work_changed': {
        const busy = Boolean(payload.busy || payload.main_turn_active);
        // 订阅初期推送的可能是滞留状态：页面未观察到轮次活动时只接受收工信号
        if (busy && !panel.petTurnActive) break;
        setAgentWorkStatus(busy ? 'thinking' : 'idle');
        break;
      }
      case 'agent.status.updated':
        handleAgentStatus(payload);
        break;
      case 'error': {
        // 供应商限流（429 引擎过载等）是服务器端的瞬时状态，会自动重试，
        // web 界面自有提示；面板显示「限流中」，下一个正常事件会覆盖
        if (payload?.code === 'provider.rate_limit') {
          setAgentStatus('ratelimit');
          break;
        }
        // 其余错误节流记录：60 秒内只记一条，避免刷屏被 Chrome 收集为扩展错误；
        // payload 内联序列化，方便从错误页直接读到内容
        const now = Date.now();
        if (now - lastServerErrorLogAt > 60_000) {
          lastServerErrorLogAt = now;
          console.warn(
            '[Kimi Status] 服务器事件错误',
            JSON.stringify(payload).slice(0, 500)
          );
        }
        break;
      }
    }
  }

  function disconnectWebSocket() {
    clearHelloWatchdog();
    clearAckWatchdog();
    awaitingAck = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectAttempts = 0;
    if (ws) {
      const current = ws;
      ws = null;
      current.onclose = null;
      current.close(1000, 'session changed');
    }
  }

  // 公共接口
  return {
    /** 建立 WebSocket 连接（幂等） */
    connect: connectWebSocket,
    /** 断开当前连接并取消待执行重连 */
    disconnect: disconnectWebSocket,
    /** 无连接且无待执行重连 */
    isIdle: () => !ws && !reconnectTimer,
    /** 快照成功后推进 durable/usage/turn 游标 */
    advanceCursors(seq) {
      lastSeq = Math.max(lastSeq, seq);
      lastUsageSeq = Math.max(lastUsageSeq, seq);
      lastTurnSeq = Math.max(lastTurnSeq, seq);
    },
    /** 切换会话时归零游标 */
    resetCursors() {
      lastSeq = 0;
      lastUsageSeq = -1;
      lastTurnSeq = -1;
      subscriptionCursor = 0;
    },
    /** 清除工具调用锁定状态 */
    clearToolStatus,
    /** 设置代理工作状态（受工具调用锁约束） */
    setAgentWorkStatus,
    /** 释放所有定时器与连接 */
    dispose() {
      clearToolStatus();
      disconnectWebSocket();
    }
  };
}
