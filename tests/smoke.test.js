// Smoke 测试：用 jsdom 把构建产物 dist/content.js 跑起来，
// 验证「面板真的出现在侧边栏」这一最核心的用户可见行为。
// 重构期间任何拆分/搬运改动如果弄断了装配链，这里会立刻报警。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { DAILY_STORAGE_KEY } from '../src/cli-usage.js';
import { usageDayKey } from '../src/metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// Kimi Code Web 侧边栏的最小骨架：ensureWidget 只认 aside.side > .col
const PAGE_HTML = `<!DOCTYPE html><html><body>
  <aside class="side"><div class="col">
    <div class="side-footer"></div>
  </div></aside>
</body></html>`;

function makeChromeStub() {
  return {
    runtime: {
      id: 'smoke-test-extension',
      getURL: (p) => `chrome-extension://smoke/${p}`,
      sendMessage: async () => ({ ok: false }),
      onMessage: { addListener() {} }
    },
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
        remove: async () => {}
      },
      onChanged: { addListener() {} }
    }
  };
}

function injectScript(window, file) {
  const script = window.document.createElement('script');
  script.textContent = fs.readFileSync(path.join(ROOT, file), 'utf8');
  window.document.body.appendChild(script);
}

function tick(window, ms = 0) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function createPage() {
  const dom = new JSDOM(PAGE_HTML, {
    url: 'http://localhost:3000/sessions/smoke-session',
    runScripts: 'dangerously',
    pretendToBeVisual: true
  });
  const { window } = dom;
  window.chrome = makeChromeStub();
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.fetch = async () => ({
    ok: false,
    status: 401,
    json: async () => ({}),
    text: async () => ''
  });
  return { dom, window };
}

test('smoke：脚本装配后面板出现在侧边栏，包含模块与关键区域', async () => {
  const { dom, window } = createPage();
  try {
    // npm test 会先执行 node build.mjs，这里直接注入自包含的 dist/content.js bundle
    injectScript(window, 'dist/content.js');

    await tick(window); // init → checkPageState → ensureWidget 同步完成
    const widget = window.document.getElementById('ksb-widget');
    assert.ok(widget, '面板应被注入');
    assert.ok(widget.closest('aside.side > .col'), '面板应挂在侧边栏列内');

    await tick(window, 10); // 等 activatePage 的异步初始化落地
    assert.ok(
      widget.querySelectorAll('.ksb-module').length > 0,
      '面板应渲染出至少一个信息模块'
    );
    assert.ok(widget.querySelector('.ksb-region-mini'), '应存在 Mini 区域');
  } finally {
    window.close();
  }
});

test('smoke：CLI 已连接时面板解锁并显示消耗量（回归：panel.panel 双前缀曾导致永远显示连接提示）', async () => {
  const { dom, window } = createPage();
  const todayKey = usageDayKey(new Date());
  const daily = { [todayKey]: { input: 1234, output: 567 } };
  window.chrome.runtime.sendMessage = async (msg) => {
    if (msg?.type === 'cli.usage.status') {
      return { ok: true, connected: true, scanning: false, lastScannedAt: new Date().toISOString(), fileCount: 1 };
    }
    return { ok: false };
  };
  window.chrome.storage.local.get = async () => ({ [DAILY_STORAGE_KEY]: daily });
  try {
    injectScript(window, 'dist/content.js');
    await tick(window);
    await tick(window, 10);

    const lock = window.document.getElementById('ksb-cli-lock');
    assert.ok(lock, '消耗量模块应渲染出 CLI 锁元素');
    assert.equal(lock.hidden, true, '已连接时锁提示应隐藏');
    assert.equal(
      window.document.getElementById('ksb-chart-total').textContent,
      '1.8k',
      '已连接时消耗量应显示真实数字'
    );
    assert.notEqual(
      window.document.getElementById('ksb-pet-total').textContent,
      '需连接 CLI',
      '已连接时宠物数据位不应再提示连接'
    );
  } finally {
    window.close();
  }
});

test('smoke：侧边栏缺失时不注入面板，也不抛异常', async () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost:3000/sessions/smoke-session',
    runScripts: 'dangerously',
    pretendToBeVisual: true
  });
  const { window } = dom;
  window.chrome = makeChromeStub();
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.fetch = async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => '' });
  try {
    injectScript(window, 'dist/content.js');
    await tick(window, 10);
    assert.equal(window.document.getElementById('ksb-widget'), null);
  } finally {
    window.close();
  }
});

/* ---------- popup 装配 smoke（回归：refreshStatus 漏 export 曾使入口初始化崩溃） ---------- */

test('smoke：popup 装配完整跑通，入口初始化不抛异常', async () => {
  const html = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: 'chrome-extension://smoke/popup.html',
    runScripts: 'dangerously'
  });
  const { window } = dom;
  const pageErrors = [];
  window.addEventListener('error', (e) => pageErrors.push(e.message));
  window.chrome = {
    runtime: {
      id: 'popup-smoke',
      getURL: (p) => p,
      getManifest: () => ({ version: 'test-version' }),
      sendMessage: async () => ({ ok: false }),
      onMessage: { addListener() {} },
      openOptionsPage: async () => {}
    },
    storage: {
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      onChanged: { addListener() {}, removeListener() {} }
    },
    tabs: { getCurrent: async () => undefined, create: async () => ({}) },
    permissions: { contains: async () => false }
  };
  // pet-store 的 IndexedDB 最小桩：列表返回空素材库
  const fakeReq = (result) => {
    const req = { result, onsuccess: null, onerror: null };
    queueMicrotask(() => req.onsuccess?.({ target: req }));
    return req;
  };
  const fakeStore = {
    getAll: () => fakeReq([]),
    get: () => fakeReq(undefined),
    put: () => fakeReq(undefined),
    add: () => fakeReq(undefined),
    delete: () => fakeReq(undefined)
  };
  window.indexedDB = {
    open: () => {
      const db = {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => fakeStore,
        transaction: () => ({ objectStore: () => fakeStore })
      };
      const req = { result: db, onsuccess: null, onerror: null, onupgradeneeded: null };
      queueMicrotask(() => {
        req.onupgradeneeded?.({ target: req });
        req.onsuccess?.({ target: req });
      });
      return req;
    }
  };
  try {
    injectScript(window, 'dist/popup.js');
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(pageErrors, [], 'popup 装配期间不应有页面异常');
    assert.equal(
      window.document.getElementById('version').textContent,
      'test-version',
      '入口初始化应执行到版本号写入'
    );
  } finally {
    window.close();
  }
});

/* ---------- 桌面宠物首次加载（回归：激活门槛曾使宠物首开不显示） ---------- */

test('smoke：首次打开即启用桌面宠物（无需先关再开）', async () => {
  const { dom, window } = createPage();
  // 图集校验要求 width=CELL_W*COLS(1536)、height 为 CELL_H(208) 的倍数且 ≥9 行
  window.Image = class {
    set src(_v) {
      this.width = 1536;
      this.height = 208 * 9;
      window.setTimeout(() => this.onload?.(), 0);
    }
  };
  window.matchMedia = () => ({ matches: false, addEventListener() {} });
  window.chrome.runtime.sendMessage = async (msg) => {
    if (msg?.type === 'pet.asset.active') return { ok: true, dataUrl: 'data:image/webp;base64,smoke' };
    return { ok: false };
  };
  window.chrome.storage.local.get = async () => ({ 'kimi-statusbar.roamPet': true });
  try {
    injectScript(window, 'dist/content.js');
    await tick(window, 30);
    assert.ok(
      window.document.body.querySelector('.codex-roam-pet'),
      '首开时应出现桌面宠物元素'
    );
  } finally {
    window.close();
  }
});
