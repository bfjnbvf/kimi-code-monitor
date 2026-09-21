/**
 * 注入模式的直连数据源（桌面补丁 loader 注入桌面端页面时启用）
 *
 * 页面直接走 kap-server 的 REST/WS，会话焦点直接读 location.pathname。
 * 全部数据翻译成 { v: 1, type, ... } 消息经 __vibepal.push 进入渲染层
 * （队列与分发见 bridge.js）。
 *
 * 桌面端 1.0.2 起页面从 app://renderer 加载（早期版本直接加载 kap-server 源），
 * 所以 kap 源不能写死相对路径：loader 注入时写入 window.__vibepalKapOrigin
 * （http://127.0.0.1:<port>，kap 端口每次启动随机，注入器探测后动态下发），
 * 读不到时回退相对路径（同源旧版）。跨源 fetch/WS 已实测不受 CORS 限制。
 *
 * 不可直连的部分：usageDaily（wire.jsonl 扫描在安装器侧预填成文件）与
 * external（技能代查快照），由 loader 加载后推进 push 管道（与本文件无冲突：
 * 都只进 push）。
 */

// kap-server 源：惰性读取（kap 重启换端口后注入器/loader 会更新全局值）。
// 顺带读桌面端 SPA 自己的 sessionStorage（UI 用同一来源定位 kap）；
// 再兜底从页面自己的资源记录里学——渲染进程对 kap 的请求都在 performance 里
const kapOrigin = () => globalThis.__vibepalKapOrigin || spaOrigin() || learnKapOrigin() || '';

function spaOrigin() {
  try {
    const value = sessionStorage.getItem('kimi-desktop-server-origin');
    return /^https?:\/\/127\.0\.0\.1:\d+$/.test(value || '') ? value : '';
  } catch (error) {
    return '';
  }
}

function learnKapOrigin() {
  try {
    for (const e of performance.getEntriesByType('resource')) {
      const m = /^(https?:\/\/127\.0\.0\.1:\d+)\/api\//.exec(e.name);
      if (m) return m[1];
    }
  } catch (error) {
    // performance 不可用就放弃兜底
  }
  return '';
}

import { refreshDailyChart } from './bridge.js';

// 活跃度模型：与 KapClient 同口径——证据事件 20s 无更新判空闲
const ACTIVITY_TTL_MS = 20_000;
const STATUS_TICK_MS = 2_000;
const QUOTA_INTERVAL_MS = 60_000;
const FOCUS_POLL_MS = 1_000;
// 按天积累的图表重绘节奏（无看门狗文件时图表全靠页内积累）
const DAILY_TICK_MS = 20_000;

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

  // 诊断状态（loader 的状态行展示）：改一次记一次，只在数据未到位时可见
  function debug(state) {
    try {
      globalThis.__vibepalDebug = { ...globalThis.__vibepalDebug, ...state };
    } catch (error) {
      // 忽略
    }
  }
  debug({ kapOrigin: kapOrigin() || '未知', focusedSid: '', wsState: 'init' });

  /* ---------- 额度：60s 轮询 REST ---------- */

  // kap 源未知时走相对路径：桌面端 app:// 处理器会把 /api/* 代理到 kap-server
  // （实测额度轮询相对路径可用）；WS 不行（ws://renderer 不是有效主机），
  // 所以事件流必须等源解析出来才连。
  const apiUrl = (path) => `${kapOrigin()}${path}`;

  async function pollQuota() {
    try {
      const r = await fetch(apiUrl('/api/v1/oauth/usage'));
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

  // WS 连接状态：声明必须先于 pollFocus 的首次调用——曾经因 TDZ（pollFocus
  // 同步执行时读到尚未初始化的 ws）抛错，把 startDirectMode 后半段全部炸死
  let ws = null;
  let retry = 0;

  function currentSidFromLocation() {
    return location.pathname.match(/\/sessions\/([^/?#]+)/)?.[1] || '';
  }

  async function applyFocus(sid) {
    focusedSid = sid;
    debug({ focusedSid: sid, kapOrigin: kapOrigin() || '未知' });
    let snapshot;
    try {
      const r = await fetch(apiUrl(`/api/v1/sessions/${sid}`));
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

  // 长期统计：看门狗的 usage-daily.json 走桥接推送；它缺席时图表靠
  // 页内按天积累（accumulate.js），定时合并重绘（有文件时按天取大）
  setTimeout(refreshDailyChart, 3_000);
  setInterval(refreshDailyChart, DAILY_TICK_MS);

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

  /* ---------- WS：事件流（协议与 KapClient/参考项目一致） ---------- */
  // （ws/retry 已在焦点段声明，先于 pollFocus 首次调用——TDZ 防回归见上）

  function wsSubscribe(ids) {
    if (!ids.length || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'subscribe', id: `s${Date.now()}`, payload: { session_ids: ids } }));
  }

  function connect() {
    // WS 无法走相对路径（ws://renderer 不是有效主机），必须等 kap 源解析出来。
    // 源未知时短周期重查（loader 各级来源可能在页面加载后才就绪），不走指数退避。
    const base = kapOrigin();
    if (!base) {
      debug({ wsState: '等kap源', kapOrigin: '未知' });
      setTimeout(connect, 5_000);
      return;
    }
    const url = `${base.replace(/^http/, 'ws')}/api/v1/ws?client_id=vibepal-injected`;
    try {
      ws = new WebSocket(url);
    } catch (error) {
      scheduleReconnect();
      return;
    }
    debug({ wsState: 'connecting', wsUrl: base });
    ws.onopen = () => debug({ wsState: 'open' });
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (error) { return; }
      handleServer(m);
    };
    ws.onclose = () => { ws = null; debug({ wsState: `closed(r${retry})` }); scheduleReconnect(); };
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
