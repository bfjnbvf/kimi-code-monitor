// Popup-app smoke 测试：用 jsdom 把构建产物 dist/popup-app.js 跑起来，
// 验证「独立 popup 页装配、桥接请求/响应、推送驱动消耗量刷新」。
// 数据经 window.__vibepalAsk（JS→Swift）+ window.__vibepal.push（Swift→JS）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { usageDayKey } from '../src/metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// popup 页 DOM 契约：与 vibepal Resources/popup/index.html 的板块结构一致
// （usage / external / roam-pet / footer / share overlay；account 与
// extensions 板块在页面里以 hidden 保留，JS 不接触）
const PAGE_HTML = `<!DOCTYPE html><html><head></head><body class="is-popup">
  <div id="usage-section">
    <div class="usage-data">
      <div class="usage-head">
        <div><div class="usage-title">
          <select id="usage-metric" aria-label="统计指标">
            <option value="heatmap" selected>活跃热力图</option>
            <option value="total">消耗量</option>
            <option value="input">输入</option>
            <option value="output">输出</option>
            <option value="cache">缓存命中</option>
          </select>
          <span id="usage-day"></span>
        </div></div>
        <span class="usage-big-tokens" id="usage-tokens">--</span>
      </div>
      <div class="usage-chart" id="usage-chart"></div>
      <div class="usage-dates">
        <input type="date" id="usage-start" aria-label="起始日期">
        <span class="usage-dates-sep">–</span>
        <input type="date" id="usage-end" aria-label="结束日期">
      </div>
      <div class="status-row cli-auth-row" id="cli-connected-row">
        <span class="dot ok" id="cli-status-dot"></span>
        <span id="cli-status-text">本地记录已授权</span>
        <span class="status-actions">
          <button type="button" class="action" id="cli-reauth-btn">重新授权</button>
          <button type="button" class="action" id="cli-disconnect-btn">取消</button>
        </span>
      </div>
      <div class="status-row hosts-row hidden" id="hosts-row"></div>
    </div>
    <div class="usage-lock hidden" id="cli-lock">
      <div class="usage-lock-title">开启长期用量统计</div>
      <div class="usage-lock-desc">desc</div>
      <div class="usage-path-help" id="cli-path-help"></div>
      <button type="button" class="cli-primary" id="cli-connect-btn">连接本地 CLI</button>
    </div>
    <div class="cli-error hidden" id="cli-error" role="alert"></div>
  </div>
  <div id="account-section" class="hidden"></div>
  <div id="external-section">
    <div class="section-head"><div class="feature-title"><span class="usage-title">外部账户</span></div></div>
    <div id="external-list"></div>
    <div id="external-add" class="hidden">
      <div class="ext-row">
        <select id="ext-provider-select"></select>
        <input type="password" id="ext-key-input" placeholder="粘贴 API Key">
        <button type="button" class="action primary" id="ext-add-save">保存</button>
      </div>
      <div class="ext-status" id="ext-add-status"></div>
    </div>
    <button type="button" class="action" id="ext-add-btn">+ 添加账户</button>
  </div>
  <div id="roam-pet-section" class="feature-card">
    <div class="section-head">
      <span class="usage-title">桌面宠物</span>
      <label class="feature-toggle"><input type="checkbox" id="roam-pet-toggle" class="kswitch-input"><span class="kswitch"></span></label>
    </div>
    <div class="feature-body">
      <div id="roam-pet-list"></div>
      <div class="ext-row hidden" id="roam-pet-add">
        <input type="text" id="roam-pet-input" placeholder="粘贴宠物安装 bash 命令">
        <button type="button" class="action primary" id="roam-pet-install">安装</button>
      </div>
      <div class="pet-note" id="roam-pet-status" hidden></div>
      <button type="button" class="action" id="roam-pet-add-btn">+ 添加宠物</button>
      <div class="feature-divider"></div>
      <div class="feature-option">
        <span>宠物大小</span>
        <span class="status-actions">
          <button type="button" class="action" id="roam-pet-scale-reset">重置</button>
          <button type="button" class="action" id="roam-pet-scale-up">放大</button>
          <button type="button" class="action" id="roam-pet-scale-down">缩小</button>
        </span>
      </div>
    </div>
  </div>
  <div id="extensions-section" class="feature-card hidden"></div>
  <div class="footer">
    <span><a href="#" id="export-link">导出统计</a> · <a href="#" id="share-card-btn">分享用量</a></span>
    <span>v<span id="version"></span> · <a href="https://github.com/bfjnbvf/kimi-code-monitor/releases" target="_blank" rel="noopener">检查更新</a> · <a href="#" id="quit-link">退出 VibePal</a></span>
  </div>
  <div id="share-card-overlay" class="hidden">
    <div class="share-card-dialog">
      <img id="share-card-preview" alt="用量分享卡片预览">
      <div class="share-card-actions">
        <button type="button" class="action primary" id="share-card-download">下载 PNG</button>
        <button type="button" class="action" id="share-card-copy">复制图片</button>
        <button type="button" class="action" id="share-card-close">关闭</button>
      </div>
      <div class="share-card-status" id="share-card-status"></div>
    </div>
  </div>
</body></html>`;

function injectScript(window, file) {
  const script = window.document.createElement('script');
  script.textContent = fs.readFileSync(path.join(ROOT, file), 'utf8');
  window.document.body.appendChild(script);
}

function tick(window, ms = 0) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

// 收到的 JS → Swift 请求（含 __askId），供断言
const asked = [];

function createPage() {
  const dom = new JSDOM(PAGE_HTML, {
    url: 'http://localhost:3000/popup/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true
  });
  const { window } = dom;
  asked.length = 0;
  window.__vibepalAsk = (msg) => {
    asked.push(msg);
    const reply = fakeSwift(msg);
    setTimeout(() => window.__vibepalAskReply?.(msg.__askId, reply), 0);
  };
  return { dom, window };
}

function fakeSwift(msg) {
  switch (msg?.type) {
    case 'cli.usage.status':
      return { ok: true, connected: true, scanning: false, progress: 0 };
    case 'cli.usage.refresh':
      return { ok: true };
    case 'cli.usage.disconnect':
      return { ok: true };
    case 'external.status':
      return { ok: true, providers: [] };
    case 'pets.list':
      return {
        ok: true,
        visible: true,
        pets: [{ id: 'v1', name: '小鸟游六花', current: true, removable: false }]
      };
    case 'pets.install':
      return { ok: true, pet: { id: 'newpet', name: '新宠物' } };
    case 'export.usage':
      return { ok: true, path: '/tmp/kimi-usage-test.json' };
    default:
      return { ok: true };
  }
}

async function bootstrapPopup(window) {
  injectScript(window, 'dist/popup-app.js');
  // 等初始化链走完（refreshCliStatus / external / pets 的请求-响应）
  await tick(window, 30);
}

test('popup-app：三大板块装配到位（用量 / 外部账户 / 桌面宠物）', async () => {
  const { dom, window } = createPage();
  try {
    await bootstrapPopup(window);

    // 外部账户：provider 下拉构建出 4 家
    const options = window.document.querySelectorAll('#ext-provider-select option');
    assert.equal(options.length, 4, '外部账户应有 4 家 provider');
    assert.ok(
      [...options].some((o) => o.textContent.includes('DeepSeek')),
      '应包含 DeepSeek'
    );

    // 桌面宠物：列表渲染 + 开关就位
    const petRows = window.document.querySelectorAll('#roam-pet-list .ext-row');
    assert.equal(petRows.length, 1, '应渲染一只宠物');
    assert.ok(
      window.document.querySelector('#roam-pet-list .account-badge'),
      '当前宠物应有徽标'
    );
    assert.equal(
      window.document.getElementById('roam-pet-toggle').checked,
      true,
      '开关应与 Swift 回读状态一致'
    );

    // 隐藏板块保留结构但不渲染内容
    assert.ok(
      window.document.getElementById('account-section').classList.contains('hidden'),
      'Kimi 账户板块应隐藏'
    );
    assert.ok(
      window.document.getElementById('extensions-section').classList.contains('hidden'),
      '扩展功能板块应隐藏'
    );
  } finally {
    window.close();
  }
});

test('popup-app：CLI 状态请求解锁用量板块，推送的统计经 storage 刷新热力图', async () => {
  const { dom, window } = createPage();
  try {
    await bootstrapPopup(window);

    // cli.usage.status 经桥接请求/响应拿到 connected → 锁隐藏、状态文案就位
    assert.ok(asked.some((m) => m.type === 'cli.usage.status'), '应请求 CLI 状态');
    assert.equal(
      window.document.getElementById('cli-lock').classList.contains('hidden'),
      true,
      'App 常连本地记录：锁提示应隐藏'
    );
    assert.equal(
      window.document.getElementById('cli-status-text').textContent,
      '本地记录已授权',
      '状态文案应为已授权'
    );

    // Swift 推送 usageDaily → shim 写 storage → onChanged → usage.js 刷新
    const todayKey = usageDayKey(new Date());
    window.__vibepal.push({
      v: 1, type: 'usageDaily',
      daily: { [todayKey]: { input: 42000, output: 3800, cacheRead: 21800, sub: { input: 8200, output: 900, cacheRead: 2500 } } },
      hourly: {},
      secondaryModel: 'kimi-k2-thinking-turbo',
      connected: true
    });
    await tick(window, 10);
    assert.equal(
      window.document.getElementById('usage-tokens').textContent,
      '45.8k',
      '热力图大数字应显示窗口总消耗'
    );
    assert.ok(
      window.document.querySelectorAll('#usage-chart .usage-heat-cell').length > 0,
      '应渲染热力图格子'
    );
    // 指标切到消耗量：区间汇总 + 主/子拆分 tooltip
    const metric = window.document.getElementById('usage-metric');
    metric.value = 'total';
    metric.dispatchEvent(new window.Event('change', { bubbles: true }));
    await tick(window, 10);
    assert.equal(
      window.document.getElementById('usage-tokens').textContent,
      '45.8k',
      '消耗量指标大数字应一致'
    );
  } finally {
    window.close();
  }
});

test('popup-app：appInfo 推送写版本号，退出与开关走桥接', async () => {
  const { dom, window } = createPage();
  try {
    await bootstrapPopup(window);

    window.__vibepal.push({ v: 1, type: 'appInfo', version: '1.0.0' });
    assert.equal(
      window.document.getElementById('version').textContent,
      '1.0.0',
      '版本号应来自 appInfo 推送'
    );

    // 桌宠开关：切换即发桥接请求（UserDefaults 由 Swift 落）
    asked.length = 0;
    const toggle = window.document.getElementById('roam-pet-toggle');
    toggle.checked = false;
    toggle.dispatchEvent(new window.Event('change', { bubbles: true }));
    await tick(window, 5);
    assert.ok(
      asked.some((m) => m.type === 'pets.visible' && m.payload?.visible === false),
      '关桌宠应发 pets.visible 请求'
    );

    // 退出 VibePal（右键 NSMenu 移除后的替代入口）
    asked.length = 0;
    window.document.getElementById('quit-link').click();
    await tick(window, 5);
    assert.ok(asked.some((m) => m.type === 'quit'), '退出链接应发 quit 请求');
  } finally {
    window.close();
  }
});
