import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { t, statusText, getLocale, syncLocaleFromPage, LOCALE_MIRROR_STORAGE_KEY } from '../src/i18n.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const i18nSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n.js'), 'utf8');
const contentJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'content.js'), 'utf8');

// 测试在 node 环境跑：无 localStorage/navigator，syncLocaleFromPage 回退默认为 zh
//（navigator 存在时为 en-US，需注意顺序）

test('默认中文：t() 原样返回中文键', () => {
  // 前一个测试可能切到英文，先重置回中文
  globalThis.localStorage = { getItem: () => 'zh' };
  syncLocaleFromPage();
  assert.equal(getLocale(), 'zh');
  assert.equal(t('输入'), '输入');
  assert.equal(statusText('idle'), '空闲');
});

test('英文：t() 查 EN 表，缺失键回退中文原文', () => {
  globalThis.localStorage = { getItem: () => 'en' };
  const changed = syncLocaleFromPage();
  assert.equal(changed, true);
  assert.equal(getLocale(), 'en');
  assert.equal(t('输入'), 'Input');
  assert.equal(t('缓存命中'), 'Cache hit');
  assert.equal(statusText('thinking'), 'Thinking');
  assert.equal(t('没有翻译的键'), '没有翻译的键');
});

test('占位符替换：两种语言都生效', () => {
  globalThis.localStorage = { getItem: () => 'en' };
  syncLocaleFromPage();
  assert.equal(t('{totalMin}分钟后重置', { totalMin: 45 }), 'Resets in 45m');
  globalThis.localStorage = { getItem: () => 'zh' };
  syncLocaleFromPage();
  assert.equal(t('{totalMin}分钟后重置', { totalMin: 45 }), '45分钟后重置');
});

test('kimi-locale 缺失时回退浏览器语言；切回中文', () => {
  globalThis.localStorage = { getItem: () => null };
  syncLocaleFromPage();
  // node 的 navigator.language 为 en-US → en；jsdom 测试显式锁定 zh 不受影响
  const expected = globalThis.navigator?.language?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  assert.equal(getLocale(), expected);
  globalThis.localStorage = { getItem: () => 'zh' };
  syncLocaleFromPage();
  assert.equal(getLocale(), 'zh');
});

test('语言变化时镜像到 chrome.storage（供 popup 读取）并触发面板重建', () => {
  // 镜像键名与写入逻辑
  assert.equal(LOCALE_MIRROR_STORAGE_KEY, 'kimi-statusbar.locale');
  assert.match(i18nSource, /chrome\.storage\.local\.set\(\{ \[LOCALE_MIRROR_STORAGE_KEY\]: next \}\)/);
  // 读取的是 Kimi Web 的语言设置键
  assert.match(i18nSource, /getItem\(PAGE_LOCALE_KEY\)/);
  assert.match(i18nSource, /PAGE_LOCALE_KEY = 'kimi-locale'/);
  // content.js 轮询检测语言变化并重建面板结构
  assert.match(contentJs, /syncLocaleFromPage\(\) && pageActivated/);
  assert.match(contentJs, /renderWidgetStructure\(\)/);
});

test('面板字符串迁移到位：render/widget/quota/ws 均走 t()', () => {
  const render = fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'render.js'), 'utf8');
  const widget = fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'widget-structure.js'), 'utf8');
  const quota = fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'quota.js'), 'utf8');
  const ws = fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'websocket-session.js'), 'utf8');
  assert.match(render, /import \{ t, statusText \} from '\.\.\/i18n\.js'/);
  assert.match(widget, /import \{ t \} from '\.\.\/i18n\.js'/);
  assert.match(quota, /import \{ t \} from '\.\.\/i18n\.js'/);
  assert.match(ws, /import \{ t \} from '\.\.\/i18n\.js'/);
  // MODULE_HTML 惰性化（热切换语言时重建结构能取到新语言）
  assert.match(widget, /input: \(\) => `/);
  assert.match(widget, /MODULE_HTML\[id\]\(\)/);
});

test('popup：语言从镜像初始化并先于板块装配，静态 HTML 由应用器翻译', () => {
  const popupJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'popup.js'), 'utf8');
  // 语言初始化 → 静态 HTML 应用 → 板块装配（顺序敏感）
  assert.ok(
    popupJs.indexOf('await initPopupLocale()') < popupJs.indexOf('applyPopupI18n(document)') &&
    popupJs.indexOf('applyPopupI18n(document)') < popupJs.indexOf('refreshStatus()'),
    'initPopupLocale → applyPopupI18n → 板块装配的顺序不能乱'
  );
  // 镜像读取 + 浏览器语言回退
  assert.match(i18nSource, /async function initPopupLocale\(\)/);
  assert.match(i18nSource, /chrome\.storage\.local\.get\(LOCALE_MIRROR_STORAGE_KEY\)/);
  // 应用器：叶子文本、常见属性、info-tip 长文、混排文本节点（推荐画廊等）
  assert.match(i18nSource, /export function applyPopupI18n\(root\)/);
  assert.match(i18nSource, /I18N_ATTRS = \['title', 'placeholder', 'aria-label', 'value'\]/);
  assert.match(i18nSource, /classList\?\.contains\('info-tip'\)/);
  assert.match(i18nSource, /createTreeWalker/);
  // 中文环境应用器不动 DOM（早退）
  assert.match(i18nSource, /if \(currentLocale !== 'en'\) return;/);
});

test('popup footer：英文长文案整体换行不在词中断行', () => {
  const popupCss = fs.readFileSync(path.join(__dirname, '..', 'popup.css'), 'utf8');
  assert.match(popupCss, /\.footer \{[\s\S]*?flex-wrap: wrap/);
  assert.match(popupCss, /\.footer span \{[\s\S]*?white-space: nowrap/);
});

test('popup 板块字符串迁移到位', () => {
  const usage = fs.readFileSync(path.join(__dirname, '..', 'src', 'popup', 'usage.js'), 'utf8');
  const accounts = fs.readFileSync(path.join(__dirname, '..', 'src', 'popup', 'accounts.js'), 'utf8');
  const external = fs.readFileSync(path.join(__dirname, '..', 'src', 'popup', 'external.js'), 'utf8');
  const tidy = fs.readFileSync(path.join(__dirname, '..', 'src', 'popup', 'tidy.js'), 'utf8');
  const pets = fs.readFileSync(path.join(__dirname, '..', 'src', 'popup', 'pets.js'), 'utf8');
  const shareCard = fs.readFileSync(path.join(__dirname, '..', 'src', 'popup', 'share-card.js'), 'utf8');
  // rename.js v2 起仅剩总开关（无用户可见文案），不要求引入 t()
  for (const [name, src] of Object.entries({ usage, accounts, external, tidy, pets, shareCard })) {
    assert.match(src, /import \{ t \} from '\.\.\/i18n\.js'/, `${name} 应引入 t()`);
  }
});

test('上下文消歧：[close]关闭 英文 Close，开关态 关闭 英文 Off，中文都显示 关闭', () => {
  globalThis.localStorage = { getItem: () => 'zh' };
  syncLocaleFromPage();
  assert.equal(t('[close]关闭'), '关闭');
  assert.equal(t('关闭'), '关闭');
  globalThis.localStorage = { getItem: () => 'en' };
  syncLocaleFromPage();
  assert.equal(t('[close]关闭'), 'Close');
  assert.equal(t('关闭'), 'Off');
  globalThis.localStorage = { getItem: () => 'zh' };
  syncLocaleFromPage();
});

test('收藏与分享卡片迁移到位，语言切换时收藏 UI 同步重刷', () => {
  const bookmarks = fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'bookmarks.js'), 'utf8');
  const shareCard = fs.readFileSync(path.join(__dirname, '..', 'src', 'share-card.js'), 'utf8');
  assert.match(bookmarks, /import \{ t \} from '\.\.\/i18n\.js'/);
  assert.match(shareCard, /import \{ t \} from '\.\/i18n\.js'/);
  // 分享卡片标题与汇总行走 t()
  assert.match(shareCard, /t\('Kimi Code 用量'\)/);
  assert.match(shareCard, /t\('范围汇总'\)/);
  assert.match(shareCard, /t\('每日消耗'\)/);
  // 收藏：语言热切换重刷侧栏按钮/星标 tooltip/收藏页
  assert.match(bookmarks, /export function refreshBookmarksLocale\(\)/);
  assert.match(contentJs, /refreshBookmarksLocale\(\)/);
  // 详情弹层关闭按钮用消歧键（Close 而非 Off）
  assert.match(bookmarks, /t\('\[close\]关闭'\)/);
});
