// 收藏页 smoke 测试：用 jsdom 跑构建产物 dist/bookmarks-page.js，
// 验证独立标签页能读存储、渲染列表、打开详情（不依赖宿主页面）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORAGE_KEY = 'kimi-statusbar.bookmarks';

const STORE = {
  sessions: {
    s1: {
      title: '会话一',
      items: {
        t1: {
          title: '回复一',
          question: '问题一',
          html: '<p>正文一</p>',
          createdAt: 1793000000000
        }
      }
    }
  }
};

function createPage() {
  const html = fs.readFileSync(path.join(ROOT, 'bookmarks.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: 'chrome-extension://test-id/bookmarks.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true
  });
  const { window } = dom;
  window.chrome = {
    runtime: { sendMessage: async () => ({ ok: true }) },
    storage: {
      local: {
        get: async (key) => {
          if (key === STORAGE_KEY) return { [key]: STORE };
          if (key === 'kimi-statusbar.locale') return { [key]: 'zh' };
          return {};
        },
        set: async () => {}
      },
      onChanged: { addListener: () => {} }
    }
  };
  return { dom, window };
}

function injectScript(window, file) {
  const script = window.document.createElement('script');
  script.textContent = fs.readFileSync(path.join(ROOT, file), 'utf8');
  window.document.body.appendChild(script);
}

test('收藏页：独立标签页渲染列表，点击条目打开详情', async () => {
  const { dom, window } = createPage();
  try {
    injectScript(window, 'dist/bookmarks-page.js');
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    const doc = window.document;
    assert.match(doc.querySelector('.kbm-page-title').textContent, /收藏/);
    assert.equal(doc.querySelectorAll('.kbm-item').length, 1);
    assert.match(doc.querySelector('.kbm-item').textContent, /正文一/);

    doc.querySelector('.kbm-item').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const detail = doc.getElementById('kbm-detail');
    assert.ok(detail?.classList.contains('open'), '详情弹层应打开');
    assert.match(detail.textContent, /问题一/);
    assert.match(detail.textContent, /正文一/);
  } finally {
    dom.window.close();
  }
});
