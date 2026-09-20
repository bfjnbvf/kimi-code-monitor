/**
 * 注入模式的直连数据源（CDP 注入 Kimi Code 桌面端页面时启用）
 *
 * 与桥接模式（macOS App WKWebView，Swift 推送）的差异：注入页面直接走
 * kap-server 的 REST/WS，会话焦点直接读 location.pathname——比桥接模式还简单。
 * 全部数据翻译成与 bridge.js 相同的消息经 __vibepal.push 进入渲染层，
 * 两种模式的渲染/累计逻辑完全共用。
 *
 * 桌面端 1.0.2 起页面从 app://renderer 加载（早期版本直接加载 kap-server 源），
 * 所以 kap 源不能写死相对路径：loader 注入时写入 window.__vibepalKapOrigin
 * （http://127.0.0.1:<port>，kap 端口每次启动随机，注入器探测后动态下发），
 * 读不到时回退相对路径（同源旧版）。跨源 fetch/WS 已实测不受 CORS 限制。
 *
 * 不可直连的部分：usageDaily（wire.jsonl 扫描在 Swift/App 侧），由注入器经
 * CDP Runtime.evaluate 推送给桥接管道（与本文件无冲突：都只进 push）。
 */

// kap-server 源：惰性读取（kap 重启换端口后注入器会更新这个全局值）
const kapOrigin = () => globalThis.__vibepalKapOrigin || '';

// 活跃度模型：与 KapClient 同口径——证据事件 20s 无更新判空闲
const ACTIVITY_TTL_MS = 20_000;
const STATUS_TICK_MS = 2_000;
const QUOTA_INTERVAL_MS = 60_000;
const FOCUS_POLL_MS = 1_000;

const EVIDENCE_TYPES = new Set([
  'turn.started', 'turn.step.started', 'turn.step.completed',
  'thinking.delta', 'assistant.delta', 'tool.progress',
  'tool.call.started', 'tool.result'
]);

export function startDirectMode() {
  const push = (msg) => {
    try {
      globalThis.__vibepal?.push(msg);
    } catch (error) {
      // 面板装配前丢弃，bridge 就绪后由下一轮周期数据补上
    }
  };

  /* ---------- 额度：60s 轮询同源 REST ---------- */

  async function pollQuota() {
    try {
      const r = await fetch(`${kapOrigin()}/api/v1/oauth/usage`);
      const body = await r.json();
      const usages = body?.data?.quota?.usages;
      if (usages) push({ v: 1, type: 'quota', quota: usages });
    } catch (error) {
      // 实例暂不可达：下轮重试
    }
  }
  pollQuota();
  setInterval(pollQuota, QUOTA_INTERVAL_MS);

  /* ---------- 会话焦点：读 SPA 路由（注入版独有，精确跟随） ---------- */

  let focusedSid = '';
  let lastActiveAt = 0;
  let lastStatus = '';

  function currentSidFromLocation() {
    return location.pathname.match(/\/sessions\/([^/?#]+)/)?.[1] || '';
  }

  async function applyFocus(sid) {
    focusedSid = sid;
    let snapshot;
    try {
      const r = await fetch(`${kapOrigin()}/api/v1/sessions/${sid}`);
      const body = await r.json();
      if (body?.data?.usage) snapshot = { usage: body.data.usage };
    } catch (error) {
      // 快照失败不阻塞切换：面板从 WS 事件重建
    }
    push({ v: 1, type: 'session', sid, snapshot });
  }

  function pollFocus() {
    const sid = currentSidFromLocation();
    if (sid && sid !== focusedSid) {
      applyFocus(sid);
      wsSubscribe([sid]);
    }
  }
  pollFocus();
  setInterval(pollFocus, FOCUS_POLL_MS);

  /* ---------- 整体状态：活跃度模型（详见 KapClient 同口径注释） ---------- */

  function noteActivity() {
    lastActiveAt = Date.now();
    setStatus('working');
  }

  function setStatus(status) {
    if (status === lastStatus) return;
    lastStatus = status;
    push({ v: 1, type: 'status', status, sessionId: focusedSid });
  }

  setInterval(() => {
    if (lastStatus === 'working' && Date.now() - lastActiveAt > ACTIVITY_TTL_MS) {
      setStatus('idle');
    }
  }, STATUS_TICK_MS);

  /* ---------- WS：同源事件流（协议与 KapClient/参考项目一致） ---------- */

  let ws = null;
  let retry = 0;

  function wsSubscribe(ids) {
    if (!ids.length || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'subscribe', id: `s${Date.now()}`, payload: { session_ids: ids } }));
  }

  function connect() {
    // kap 源已知就用绝对地址（app:// 页面跨源）；否则回退同源相对地址（旧版桌面端）
    const base = kapOrigin();
    const url = base
      ? `${base.replace(/^http/, 'ws')}/api/v1/ws?client_id=vibepal-injected`
      : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/ws?client_id=vibepal-injected`;
    try {
      ws = new WebSocket(url);
    } catch (error) {
      scheduleReconnect();
      return;
    }
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (error) { return; }
      handleServer(m);
    };
    ws.onclose = () => { ws = null; scheduleReconnect(); };
    ws.onerror = () => { try { ws?.close(); } catch (error) { /* 忽略 */ } };
  }

  function scheduleReconnect() {
    const delay = Math.min(30_000, 1_000 * 2 ** retry);
    retry += 1;
    setTimeout(connect, delay);
  }

  function handleServer(m) {
    if (m.type === 'server_hello') {
      retry = 0;
      ws?.send(JSON.stringify({
        type: 'client_hello',
        id: 'h1',
        payload: {
          client_id: 'vibepal-injected',
          subscriptions: focusedSid ? [focusedSid] : [],
          cursors: {}
        }
      }));
      return;
    }
    if (m.type === 'ping') {
      ws?.send(JSON.stringify({ type: 'pong', payload: { nonce: m.payload?.nonce } }));
      return;
    }
    if (m.type === 'ack') {
      const resync = m.payload?.resync_required || [];
      if (resync.length) wsSubscribe(resync);
      return;
    }
    // 工作证据：phase 携带的 agent.status.updated 也算
    if (EVIDENCE_TYPES.has(m.type)
      || (m.type === 'agent.status.updated' && m.payload?.phase)) {
      noteActivity();
    }
    push({ v: 1, type: 'event', event: m });
  }

  connect();
}
