// WS 状态机行为测试：在 jsdom 里运行真实构建产物 dist/content.js，
// 用假 WebSocket + 虚拟定时器驱动协议事件，验证 P0 修复的正确性行为：
// 握手游标、session 闸门、NaN 序号防线、重放闸门、durable 去重、重连上限。
// 跑之前需要 dist/ 已构建（npm test 会先执行 build）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SESSION_ID = 's1';
const PAGE_HTML = `<!DOCTYPE html><html><body>
  <aside class="side"><div class="col"><div class="side-footer"></div></div></aside>
</body></html>`;

/* ---------- 测试替身 ---------- */

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  message(obj) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1006, reason: '' });
  }
}
FakeWebSocket.instances = [];

// 虚拟定时器：模块里的 setTimeout/setInterval 全部入队，由测试手动推进
function installFakeTimers(window) {
  let nextId = 1;
  const timers = [];
  const state = { now: 1_000_000 };

  window.setTimeout = (cb, delay = 0) => {
    const t = { id: nextId++, cb, at: state.now + delay, interval: 0 };
    timers.push(t);
    return t.id;
  };
  window.setInterval = (cb, delay = 0) => {
    const t = { id: nextId++, cb, at: state.now + delay, interval: delay };
    timers.push(t);
    return t.id;
  };
  const clear = (id) => {
    const i = timers.findIndex((t) => t.id === id);
    if (i >= 0) timers.splice(i, 1);
  };
  window.clearTimeout = clear;
  window.clearInterval = clear;
  window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(state.now), 16);
  window.Date.now = () => state.now;

  // 执行下一个到期定时器；返回是否执行了
  function runNext() {
    if (!timers.length) return false;
    timers.sort((a, b) => a.at - b.at);
    const t = timers.shift();
    state.now = Math.max(state.now, t.at);
    if (t.interval) {
      t.at = state.now + t.interval;
      timers.push(t);
    }
    t.cb();
    return true;
  }

  return { runNext, state };
}

/* ---------- 页面装配 ---------- */

async function createSessionPage() {
  const dom = new JSDOM(PAGE_HTML, {
    url: `http://localhost:3000/sessions/${SESSION_ID}`,
    runScripts: 'dangerously',
    pretendToBeVisual: true
  });
  const { window } = dom;
  FakeWebSocket.instances = [];
  window.WebSocket = FakeWebSocket;
  window.chrome = {
    runtime: {
      id: 'ws-test-extension',
      getURL: (p) => `chrome-extension://ws/${p}`,
      sendMessage: async () => ({ ok: false }),
      onMessage: { addListener() {} }
    },
    storage: {
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      onChanged: { addListener() {} }
    }
  };
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // 快照：input 2000 / output 1000 / last_seq 5
  window.fetch = async (url) => {
    assert.match(String(url), new RegExp(`/api/v1/sessions/${SESSION_ID}`));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          usage: { input_tokens: 2000, output_tokens: 1000 },
          last_seq: 5,
          busy: false
        }
      }),
      text: async () => ''
    };
  };
  const timers = installFakeTimers(window);
  window.localStorage.setItem(
    'kimi-web.server-credential',
    JSON.stringify({ credential: 'test-token' })
  );

  const script = window.document.createElement('script');
  script.textContent = fs.readFileSync(path.join(ROOT, 'dist', 'content.js'), 'utf8');
  window.document.body.appendChild(script);

  // 用真实宏任务等 activatePage 的异步链（fetch/storage 都是 Promise）落地
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
  await tick();

  const ws = FakeWebSocket.instances[0];
  assert.ok(ws, '快照成功后应建立 WebSocket');
  return { dom, window, timers, ws };
}

function inputText(window) {
  return window.document.getElementById('ksb-input-tokens').textContent;
}

// 握手并放行到实时事件阶段（ack 之后）
function handshake(ws) {
  ws.open();
  ws.message({ type: 'server_hello' });
  ws.message({ type: 'ack' });
}

/* ---------- 用例 ---------- */

test('握手：快照游标带进 client_hello，ping 回应 pong', async () => {
  const { dom, window, ws } = await createSessionPage();
  try {
    assert.match(ws.url, /\/api\/v1\/ws\?client_id=kimi-statusbar/);
    // protocols 数组诞生于 jsdom realm，与 Node 数组 prototype 不同，逐元素比较
    assert.equal(ws.protocols.length, 1);
    assert.equal(ws.protocols[0], 'kimi-code.bearer.test-token');
    assert.equal(inputText(window), '2k', '快照数据应渲染到面板');

    ws.open();
    ws.message({ type: 'server_hello' });
    const hello = ws.sent.find((f) => f.type === 'client_hello');
    assert.ok(hello, 'server_hello 后应发送 client_hello');
    assert.deepEqual(hello.payload.subscriptions, [SESSION_ID]);
    // 首次订阅游标固定为 0（换取历史重放填充折线样本）
    assert.deepEqual(hello.payload.cursors, { [SESSION_ID]: { seq: 0 } });

    ws.message({ type: 'ping', payload: { nonce: 'n-1' } });
    const pong = ws.sent.find((f) => f.type === 'pong');
    assert.deepEqual(pong, { type: 'pong', payload: { nonce: 'n-1' } });
  } finally {
    dom.window.close();
  }
});

test('session 闸门：其他会话的事件一律不计入', async () => {
  const { dom, window, ws } = await createSessionPage();
  try {
    handshake(ws);
    ws.message({
      type: 'turn.step.completed',
      session_id: 'other-session',
      seq: 6,
      payload: { usage: { input_tokens: 500 } }
    });
    assert.equal(inputText(window), '2k', '错会话事件不得改变计数');
  } finally {
    dom.window.close();
  }
});

test('重放闸门：ack 之前的历史 step 只进样本不进计数，ack 之后才计数', async () => {
  const { dom, window, ws } = await createSessionPage();
  try {
    ws.open();
    ws.message({ type: 'server_hello' });
    // 还在 awaitingAck：历史重放（游标 0）不计数
    ws.message({
      type: 'turn.step.completed',
      session_id: SESSION_ID,
      seq: 6,
      payload: { usage: { input_tokens: 500 } }
    });
    assert.equal(inputText(window), '2k', '重放事件不得计入');

    ws.message({ type: 'ack' });
    ws.message({
      type: 'turn.step.completed',
      session_id: SESSION_ID,
      seq: 7,
      payload: { usage: { input_tokens: 500 } }
    });
    assert.equal(inputText(window), '2.5k', 'ack 后的实时事件必须计入');
  } finally {
    dom.window.close();
  }
});

test('NaN 序号防线：非法 seq 不污染游标，后续事件仍正常去重', async () => {
  const { dom, window, ws } = await createSessionPage();
  try {
    handshake(ws);
    // 非法 seq：事件处理，但游标不动
    ws.message({
      type: 'turn.step.completed',
      session_id: SESSION_ID,
      seq: 'not-a-number',
      payload: { usage: { input_tokens: 100 } }
    });
    assert.equal(inputText(window), '2.1k', '非法 seq 的事件本身应被处理');

    // 后续正常 seq 事件必须仍然生效（若游标被 NaN 污染，这里会被错误跳过）
    ws.message({
      type: 'turn.step.completed',
      session_id: SESSION_ID,
      seq: 8,
      payload: { usage: { input_tokens: 100 } }
    });
    assert.equal(inputText(window), '2.2k', '游标未被污染，正常事件继续计入');
  } finally {
    dom.window.close();
  }
});

test('durable 去重：ack 后相同 seq 的事件不重复计数', async () => {
  const { dom, window, ws } = await createSessionPage();
  try {
    handshake(ws);
    const frame = {
      type: 'turn.step.completed',
      session_id: SESSION_ID,
      seq: 9,
      payload: { usage: { input_tokens: 100 } }
    };
    ws.message(frame);
    ws.message(frame);
    assert.equal(inputText(window), '2.1k', '相同 seq 只计一次');
  } finally {
    dom.window.close();
  }
});

test('重连上限：连续失败达到上限后停止新建连接，转入低频探测', async () => {
  const { dom, window, timers, ws } = await createSessionPage();
  try {
    handshake(ws);
    const initialCount = FakeWebSocket.instances.length;

    // 持续断线：每轮关掉当前连接，然后推进虚拟定时器直到出现新连接；
    // 路由轮询与退避定时器节奏不同，逐轮驱动才能稳定走到上限
    let closes = 0;
    while (closes < 15) {
      const current = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
      if (current && current.readyState !== FakeWebSocket.CLOSED) {
        current.close();
        closes += 1;
      }
      const before = FakeWebSocket.instances.length;
      let pumped = 0;
      while (FakeWebSocket.instances.length === before && pumped < 500 && timers.runNext()) {
        pumped += 1;
      }
      if (FakeWebSocket.instances.length === before) break; // 已达上限，不再重连
    }

    const cappedCount = FakeWebSocket.instances.length;
    assert.ok(
      cappedCount - initialCount <= 10,
      `重连不应无限新建连接（初始 ${initialCount}，现有 ${cappedCount}）`
    );
    assert.ok(closes >= 10, '应已触发足够多次断线来触及上限');
    assert.match(
      window.document.getElementById('ksb-widget').title,
      /暂停自动重连/,
      '达到上限后应提示已暂停自动重连'
    );

    // 上限后只剩 60s 探测，不再产生新连接
    for (let i = 0; i < 10; i += 1) timers.runNext();
    assert.equal(FakeWebSocket.instances.length, cappedCount, '探测阶段不应新建连接');
  } finally {
    dom.window.close();
  }
});
