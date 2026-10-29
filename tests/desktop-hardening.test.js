import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

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

test('会话快照在焦点变化后丢弃乱序响应', () => {
  const source = fs.readFileSync(new URL('../src/panel-app/direct.js', import.meta.url), 'utf8');
  assert.match(source, /generation !== focusGeneration \|\| focusedSid !== sid/);
  const kapSource = fs.readFileSync(new URL('../src/panel-app/kap.js', import.meta.url), 'utf8');
  assert.match(kapSource, /AbortSignal\.timeout\(15_000\)/);
});

test('钱包快照只写入白名单字段且异常金额不落零', () => {
  const source = fs.readFileSync(new URL('../src/panel-app/patch/fetch-wallet.mjs', import.meta.url), 'utf8');
  assert.match(source, /const safeWallet = \{/);
  assert.match(source, /余额字段格式异常/);
  assert.doesNotMatch(source, /JSON\.stringify\(\{ wallet, fetchedAt/);
});

test('WS 丢弃非当前会话帧', () => {
  const source = fs.readFileSync(new URL('../src/panel-app/direct.js', import.meta.url), 'utf8');
  assert.match(source, /eventSid && eventSid !== focusedSid/);
});
