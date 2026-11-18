import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

test('kap 地址只接受显式端口的回环源', async () => {
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.chrome = { runtime: { getURL: (value) => value } };
  const { normalizeKapOrigin } = await import('../src/panel-app/direct.js');
  for (const value of ['http://127.0.0.1:61890', 'http://localhost:61890', 'http://[::1]:61890']) {
    assert.ok(normalizeKapOrigin(value));
  }
  for (const value of [
    'https://example.com:61890',
    'http://127.0.0.1',
    'http://user:pass@127.0.0.1:61890',
    'file:///tmp/kcm',
    'not a url'
  ]) assert.equal(normalizeKapOrigin(value), '');
});

test('loader 保留宿主引用且 Rive 失败仍加载核心面板', () => {
  const source = fs.readFileSync(new URL('../src/panel-app/patch/loader.js', import.meta.url), 'utf8');
  assert.match(source, /panelHost = host/);
  assert.match(source, /rive\.onerror = loadApp/);
  assert.match(source, /loopbackOrigin/);
});

test('loader 统计版本不变时不重复加载完整数据', () => {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><aside class="side"><div class="col"></div></aside></body></html>', {
    url: 'http://localhost:3000/sessions/session_poll', runScripts: 'outside-only'
  });
  const { window } = dom;
  const timers = new Map();
  let timerId = 0;
  window.setTimeout = (callback, delay) => {
    const id = ++timerId;
    timers.set(id, { callback, delay });
    return id;
  };
  window.clearTimeout = (id) => timers.delete(id);
  window.setInterval = () => ++timerId;
  let version = 'v1';
  let payloadLoads = 0;
  let pushes = 0;
  window.__kcm = { push: (msg) => { if (msg.type === 'usageDaily') pushes += 1; } };
  const append = window.document.head.appendChild.bind(window.document.head);
  window.document.head.appendChild = (node) => {
    if (node.tagName !== 'SCRIPT') return append(node);
    const src = node.src || '';
    if (src.includes('usage-daily-version.js')) {
      window.__kcmUsageDailyVersion = version;
      node.onload();
    } else if (src.includes('usage-daily.js')) {
      payloadLoads += 1;
      window.__kcmUsageDaily = { daily: { '2026-11-18': { input: 1, output: 1 } } };
      node.onload();
    } else if (src.includes('wallet.js')) node.onerror();
    else if (src.includes('rive.js')) node.onerror();
    return node;
  };
  try {
    window.eval(fs.readFileSync(new URL('../src/panel-app/patch/loader.js', import.meta.url), 'utf8'));
    assert.equal(payloadLoads, 1);
    assert.equal(pushes, 1);
    const poll = () => {
      const entry = [...timers.values()].find((item) => item.delay === 30_000);
      assert.ok(entry);
      timers.clear();
      entry.callback();
    };
    poll();
    assert.equal(payloadLoads, 1, '版本不变只探测版本文件');
    assert.equal(pushes, 1);
    version = 'v2';
    poll();
    assert.equal(payloadLoads, 2, '版本变化才加载完整统计');
    assert.equal(pushes, 2);
  } finally {
    window.close();
  }
});

test('loader 相同诊断文字不重复写 DOM', () => {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><aside class="side"><div class="col"></div></aside><span id="kcm-data-status"></span></body></html>', {
    url: 'http://localhost:3000/sessions/session_diag', runScripts: 'outside-only'
  });
  const { window } = dom;
  let watchdog;
  window.setInterval = (callback, delay) => {
    if (delay === 1_000) watchdog = callback;
    return 1;
  };
  window.document.head.appendChild = (node) => {
    if (node.tagName === 'SCRIPT' && typeof node.onerror === 'function') node.onerror();
    return node;
  };
  const status = window.document.getElementById('kcm-data-status');
  let value = '';
  let writes = 0;
  Object.defineProperty(status, 'textContent', {
    get: () => value,
    set: (next) => { value = String(next); writes += 1; }
  });
  try {
    window.eval(fs.readFileSync(new URL('../src/panel-app/patch/loader.js', import.meta.url), 'utf8'));
    assert.equal(typeof watchdog, 'function');
    watchdog();
    assert.equal(writes, 1);
    watchdog();
    assert.equal(writes, 1, '相同诊断不重复写入');
    window.__kcmDebug = { ...window.__kcmDebug, focusedSid: 'changed-session' };
    watchdog();
    assert.equal(writes, 2, '诊断变化仍正常写入');
  } finally {
    window.close();
  }
});

test('会话快照在焦点变化后丢弃乱序响应', () => {
  const source = fs.readFileSync(new URL('../src/panel-app/direct.js', import.meta.url), 'utf8');
  assert.match(source, /generation !== focusGeneration \|\| focusedSid !== sid/);
  const kapSource = fs.readFileSync(new URL('../src/panel-app/kap.js', import.meta.url), 'utf8');
  assert.match(kapSource, /AbortSignal\.timeout\(15_000\)/);
});

test('钱包快照只写入白名单字段且异常金额不落零', async () => {
  const source = fs.readFileSync(new URL('../src/panel-app/patch/fetch-wallet.mjs', import.meta.url), 'utf8');
  assert.match(source, /const safeWallet = walletSnapshot\(wallet\)/);
  assert.match(source, /余额字段格式异常/);
  assert.doesNotMatch(source, /JSON\.stringify\(\{ wallet, fetchedAt/);

  const { balanceYuan, walletSnapshot } = await import('../src/panel-app/patch/fetch-wallet.mjs');
  assert.deepEqual(walletSnapshot({
    status: 'STATUS_ACTIVE',
    balance: { amountLeft: '500000000' },
    userId: 'private'
  }), { status: 'STATUS_ACTIVE', balance: { amountLeft: 500000000 } });
  assert.deepEqual(walletSnapshot({
    status: 'STATUS_ACTIVE',
    balance: { amount: '5000000000', unit: 'UNIT_CURRENCY' },
    userId: 'private'
  }), { status: 'STATUS_ACTIVE', balance: { amountLeft: 5000000000 } });
  assert.equal(balanceYuan({ status: 'STATUS_ACTIVE', balance: { amount: '5000000000' } }), 50);
  for (const amount of [null, '', 'invalid', undefined]) {
    assert.equal(walletSnapshot({ status: 'STATUS_ACTIVE', balance: { amount } }), null);
    assert.equal(balanceYuan({ status: 'STATUS_ACTIVE', balance: { amount } }), null);
  }
});

test('WS 丢弃非当前会话帧', () => {
  const source = fs.readFileSync(new URL('../src/panel-app/direct.js', import.meta.url), 'utf8');
  assert.match(source, /eventSid && eventSid !== focusedSid/);
});
