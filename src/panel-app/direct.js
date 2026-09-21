/**
 * 注入模式的直连数据源（桌面补丁 loader 注入桌面端页面时启用）
 *
 * 页面直接走 kap-server 的 REST/WS，会话焦点直接读 location.pathname。
 * 全部数据翻译成 { v: 1, type, ... } 消息经 __kcm.push 进入渲染层
 * （队列与分发见 bridge.js）。
 *
 * 桌面端 1.0.2 起页面从 app://renderer 加载（早期版本直接加载 kap-server 源），
 * 所以 kap 源不能写死相对路径：loader 注入时写入 window.__kcmKapOrigin
 * （http://127.0.0.1:<port>，kap 端口每次启动随机，注入器探测后动态下发），
 * 读不到时回退相对路径（同源旧版）。跨源 fetch/WS 已实测不受 CORS 限制。
 *
 * 落盘快照只有 usageDaily（wire.jsonl 扫描在安装器侧预填成文件），由 loader
 * 加载后推进 push 管道（与本文件无冲突：都只进 push）。
 */

// kap-server 源：惰性读取（kap 重启换端口后注入器/loader 会更新全局值）。
// 顺带读桌面端 SPA 自己的 sessionStorage（UI 用同一来源定位 kap）；
// 再兜底从页面自己的资源记录里学——渲染进程对 kap 的请求都在 performance 里
const kapOrigin = () => globalThis.__kcmKapOrigin || spaOrigin() || learnKapOrigin() || '';

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
import { panel } from '../content/panel-state.js';
import { classifyClientProvider } from '../providers.js';

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
      globalThis.__kcm?.push(msg);
    } catch (error) {
      // 面板装配前丢弃，bridge 就绪后由下一轮周期数据补上
    }
  };

  // 诊断状态（loader 的状态行展示）：改一次记一次，只在数据未到位时可见
  function debug(state) {
    try {
      globalThis.__kcmDebug = { ...globalThis.__kcmDebug, ...state };
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

  /* ---------- 外部账户：直连客户端自己配的 provider ---------- */
  // 账户来源就是客户端自己的 provider 配置（~/.kimi-code/config.toml），
  // 面板不再维护账户清单、也不落任何 key：
  //   GET /api/v1/providers         列出 provider（只给 has_api_key，不给 key）
  //   GET /api/v1/providers/<id>    单读会带上 api_key（客户端为本地编辑表单预填）
  // 拿到 key 后直接打厂商的余额端点，key 只在本函数内用一次：不进日志、
  // 不进诊断状态（__kcmDebug）、不写任何存储。抓不到的供应商（厂商没开放
  // 余额接口 / 我们还没适配 / 没配 key）按「未适配」上报，由面板放进编辑清单。
  const EXTERNAL_INTERVAL_MS = 60_000;
  const EXTERNAL_BACKOFF_MAX_MS = 5 * 60_000;

  async function fetchClientProviders() {
    const r = await fetch(apiUrl('/api/v1/providers'));
    const body = await r.json();
    const items = body?.data?.items;
    return Array.isArray(items) ? items : [];
  }

  async function fetchProviderKey(id) {
    const r = await fetch(apiUrl(`/api/v1/providers/${encodeURIComponent(id)}`));
    const body = await r.json();
    const key = body?.data?.api_key;
    return typeof key === 'string' ? key : '';
  }

  let externalDelay = EXTERNAL_INTERVAL_MS;

  // 每家最近一次成功抓到的数值：接口失败时沿用旧数字而不是显示「获取失败」——
  // 余额变化慢，旧的真数字比空白有用；失败原因进悬停，下一轮成功自动回到新值。
  // 渲染层靠 fetchedAt 区分「沿用旧值」与「从未成功」。
  const lastGood = new Map();

  async function pollExternal() {
    // 模块被收起时不抓（与额度轮询同策略：看不见就不打扰）
    if (panel.widgetConfig.modules.external?.show === 'hidden') {
      setTimeout(pollExternal, EXTERNAL_INTERVAL_MS);
      return;
    }
    const providers = [];
    const unsupported = [];
    try {
      for (const item of await fetchClientProviders()) {
        const id = typeof item?.id === 'string' ? item.id : '';
        const info = classifyClientProvider(item);
        // 托管账号的额度在面板顶部（5h/本周）显示，外部账户里不重复列
        if (info.kind === 'managed') continue;
        if (info.kind === 'unsupported') {
          unsupported.push({ id, host: info.host, reason: info.reason });
          continue;
        }
        if (item.has_api_key === false) {
          unsupported.push({ id, host: info.host, reason: '未配置 API key' });
          continue;
        }
        const key = await fetchProviderKey(id);
        if (!key) {
          unsupported.push({ id, host: info.host, reason: '读不到 API key' });
          continue;
        }
        const keyTail = key.slice(-4);
        const base = { id: `ext-${info.adapterId}-${keyTail}`, provider: info.adapterId, name: id, keyTail };
        try {
          const entry = { ...base, ...(await info.adapter.fetch(key)), error: '', fetchedAt: Date.now() };
          lastGood.set(base.id, entry);
          providers.push(entry);
        } catch (error) {
          const message = error?.message || String(error);
          const prev = lastGood.get(base.id);
          providers.push(prev ? { ...prev, error: message } : { ...base, error: message });
        }
      }
      push({
        v: 1, type: 'external', providers, unsupported,
        fetchedAt: new Date().toISOString()
      });
      externalDelay = EXTERNAL_INTERVAL_MS;
    } catch (error) {
      // 读不到客户端 provider 列表：退避重试（旧数据继续显示，不清空）
      debug({ externalState: `读取失败(${error?.message || error})` });
      externalDelay = Math.min(EXTERNAL_BACKOFF_MAX_MS, externalDelay * 2);
    }
    setTimeout(pollExternal, externalDelay);
  }

  setTimeout(pollExternal, 5_000);

  /* ---------- 会话焦点：读 SPA 路由（注入版独有，精确跟随） ---------- */

  let focusedSid = '';
  let lastActiveAt = 0;
  let lastStatus = '';

  // 订阅游标：本页对每个会话已消费到的事件序号。重连/切回同一会话时带上它，
  // 服务端只补发漏掉的那段；游标为 0（本页还没订阅过该会话）时服务端会把整段
  // 历史重放一遍——那批事件全部标记为「历史重放」，由 bridge 丢弃不进计数器
  // （数字已由本地汇总/同页缓存做底）。与扩展侧 websocket-session.js 同策略。
  let focusedSeq = 0;
  let awaitingAck = false;
  const cursorBySid = new Map();

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
    // 会话快照：累计用量（usage）与忙碌标志（busy）。
    // kap 目前把 usage 恒填成 0（见 bridge.js 的 usableSnapshotUsage），
    // busy 是可靠的独立字段——状态灯先靠它归位，数字部分交给同页缓存与实时事件。
    let snapshot;
    try {
      const r = await fetch(apiUrl(`/api/v1/sessions/${sid}`));
      const data = (await r.json())?.data;
      if (data && typeof data === 'object') {
        snapshot = {
          usage: data.usage,
          busy: Boolean(data.busy || data.main_turn_active)
        };
      }
    } catch (error) {
      // 快照失败不阻塞切换：面板从同页缓存与 WS 事件重建
    }
    push({ v: 1, type: 'session', sid, snapshot });
  }

  function pollFocus() {
    const sid = currentSidFromLocation();
    // 离开会话页（主页/设置等）：清掉焦点，回到同一个会话时会重新取一次快照。
    // 不清的话 sid === focusedSid 会让那次切换被跳过（面板停在离开前的状态）
    if (!sid) {
      if (focusedSid) {
        cursorBySid.set(focusedSid, focusedSeq);
        focusedSid = '';
        focusedSeq = 0;
        debug({ focusedSid: '' });
      }
      return;
    }
    if (sid === focusedSid) return;
    // 换会话：存下旧会话的水位，新会话按已记录的水位续订（没有就是 0 → 会重放历史）
    if (focusedSid) cursorBySid.set(focusedSid, focusedSeq);
    focusedSeq = cursorBySid.get(sid) || 0;
    applyFocus(sid);
    wsSubscribe([sid]);
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
    // 订阅应答（ack）之前到达的事件都算重放——边界由 handleServer 复位
    awaitingAck = true;
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
    const url = `${base.replace(/^http/, 'ws')}/api/v1/ws?client_id=kcm-injected`;
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
      awaitingAck = true;
      ws?.send(JSON.stringify({
        type: 'client_hello',
        id: 'h1',
        payload: {
          client_id: 'kcm-injected',
          subscriptions: focusedSid ? [focusedSid] : [],
          // 带上本页对该会话的水位：服务端只补发漏掉的那段；0 表示还没订阅过，
          // 服务端会把整段历史重放一遍（那批事件由 bridge 按「历史重放」丢弃）
          cursors: focusedSid ? { [focusedSid]: { seq: focusedSeq } } : {}
        }
      }));
      return;
    }
    if (m.type === 'ping') {
      ws?.send(JSON.stringify({ type: 'pong', payload: { nonce: m.payload?.nonce } }));
      return;
    }
    // 订阅应答 = 重放边界：它之后到达的才是实时事件
    if (m.type === 'ack' || m.type === 'resync_required') {
      awaitingAck = false;
      cursorBySid.set(focusedSid, focusedSeq);
      const resync = m.payload?.resync_required || m.payload?.session_ids || [];
      if (resync.length) wsSubscribe(resync);
      return;
    }
    // 工作证据：phase 携带的 agent.status.updated 也算。
    // 订阅应答（ack）之前到达的是重放：重启客户端后的整段历史重放会把空闲会话
    // 抬成「思考中」，与 bridge.js 丢弃重放状态、work_changed 的 petTurnActive
    // 守卫同一口径——活跃度只认应答边界之后的实时事件
    if (!awaitingAck
      && (EVIDENCE_TYPES.has(m.type)
        || (m.type === 'agent.status.updated' && m.payload?.phase))) {
      noteActivity();
    }
    // 水位与重放标记：durable 事件才推进水位（volatile 帧复用 durable 序号）；
    // 「是否历史重放」要在推进水位之前判定——游标为 0 的订阅，应答前的整段重放
    // 就是历史，不能计进面板（数字已由本地汇总做底）
    const seq = Number(m.seq);
    const replayingHistory = awaitingAck && focusedSeq === 0;
    if (Number.isFinite(seq) && m.volatile !== true) focusedSeq = Math.max(focusedSeq, seq);
    push({
      v: 1,
      type: 'event',
      event: awaitingAck
        ? { ...m, kcmReplay: true, kcmReplayHistory: replayingHistory }
        : m
    });
  }

  connect();
}
