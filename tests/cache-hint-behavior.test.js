import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

test('空闲 29.5 分钟时宠物显示琥珀色过期提醒和倒计时', async () => {
  const dom = new JSDOM(`
    <div id="pet">
      <div id="label"></div><div id="totalText"></div><div id="statusText"></div>
      <canvas id="canvas"></canvas><div id="total"></div><div id="status"></div>
      <div id="clock"></div><span id="clockNum"></span>
    </div>`);
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.chrome = { runtime: { getURL: (value) => value } };
  const { panel } = await import('../src/content/panel-state.js');
  const { initCacheHint, disposeCacheHint } = await import('../src/content/cache-hint.js');
  panel.widgetConfig = { modules: { pet: { cacheHint: true, show: 'mini', span: 2, stat: 'daily' } } };
  panel.els = {
    petLabel: document.getElementById('label'),
    petTotalText: document.getElementById('totalText'),
    petStatusText: document.getElementById('statusText'),
    petCanvas: document.getElementById('canvas'),
    petTotal: document.getElementById('total'),
    petStatus: document.getElementById('status'),
    petClock: document.getElementById('clock'),
    petClockNum: document.getElementById('clockNum')
  };
  panel.metrics.agentStatus = 'idle';
  panel.cacheHint = { stage: 'idle', lastTouchAt: 0, painted: false };
  initCacheHint();
  globalThis.__kcmCacheHint.seed(Date.now() - 29.5 * 60_000);
  assert.equal(panel.cacheHint.painted, true);
  assert.equal(panel.els.petTotalText.textContent, '即将过期');
  assert.equal(panel.els.petStatusText.textContent, '预估剩余');
  assert.equal(panel.els.petClockNum.textContent, '0:30');
  assert.ok(panel.els.petCanvas.classList.contains('ksb-cache-hot'));
  disposeCacheHint();
});
