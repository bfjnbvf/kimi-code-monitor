import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeBookmarkStore,
  truncateTitle,
  isBookmarked,
  flattenBookmarks,
  BOOKMARKS_STORAGE_KEY
} from '../src/content/bookmarks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'bookmarks.js'), 'utf8');
const contentCss = fs.readFileSync(path.join(__dirname, '..', 'content.css'), 'utf8');
const contentJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'content.js'), 'utf8');

test('存储归一化：坏数据回退空收藏夹，合法数据保留', () => {
  assert.deepEqual(normalizeBookmarkStore(null), { sessions: {} });
  assert.deepEqual(normalizeBookmarkStore({ sessions: 'bad' }), { sessions: {} });
  const good = {
    sessions: {
      s1: { title: '会话A', items: { t1: { title: '回复一', createdAt: 100 } } },
      s2: { title: '', items: { t2: { title: 123, createdAt: 'x' } } }
    }
  };
  const normalized = normalizeBookmarkStore(good);
  assert.equal(normalized.sessions.s1.items.t1.title, '回复一');
  // 非法字段回退：title 非字符串 → ''，createdAt 非数值 → 0
  assert.equal(normalized.sessions.s2.items.t2.title, '');
  assert.equal(normalized.sessions.s2.items.t2.createdAt, 0);
});

test('标题截断：压缩空白，超限加省略号', () => {
  assert.equal(truncateTitle('  多\n行\t文本  '), '多 行 文本');
  const long = 'a'.repeat(80);
  assert.equal(truncateTitle(long).length, 61);
  assert.match(truncateTitle(long), /…$/);
  assert.equal(truncateTitle(''), '');
});

test('isBookmarked 与 flattenBookmarks（按时间倒序）', () => {
  const state = normalizeBookmarkStore({
    sessions: {
      s1: { title: 'A', items: { t1: { title: '一', createdAt: 100 }, t2: { title: '二', createdAt: 300 } } },
      s2: { title: 'B', items: { t3: { title: '三', createdAt: 200 } } }
    }
  });
  assert.equal(isBookmarked(state, 's1', 't2'), true);
  assert.equal(isBookmarked(state, 's1', 'tx'), false);
  assert.equal(isBookmarked(state, 'sx', 't1'), false);
  const rows = flattenBookmarks(state);
  assert.deepEqual(rows.map((r) => r.turnId), ['t2', 't3', 't1']);
  assert.equal(rows[0].sessionTitle, 'A');
});

test('收藏入口：星标注入 AI 回复底部控件行，点击切换收藏', () => {
  assert.match(source, /anchor\.querySelector\('\.a-msg-ft'\)/);
  assert.match(source, /btn\.className = 'kbm-star'/);
  assert.match(source, /toggleBookmark\(anchor\)/);
  // 只装饰 AI 回复轮（.a-msg），不碰用户轮
  assert.match(source, /querySelectorAll\('\.a-msg\.turn-anchor\[data-turn-id\]'\)/);
});

test('目录注入：绿色收藏行按真实位置交错插入，复制官方行的 Vue scoped 属性', () => {
  assert.match(source, /querySelector\('\.conversation-toc \.toc-scroll'\)/);
  assert.match(source, /row\.className = 'toc-row kbm-toc-row'/);
  // 交错定位：以「之前渲染的用户轮数量」计算插入位置，insertBefore 到对应官方行前
  assert.match(source, /querySelectorAll\('\.u-bub\.turn-anchor\[data-turn-id\]'\)/);
  assert.match(source, /compareDocumentPosition\(anchor\) & Node\.DOCUMENT_POSITION_FOLLOWING/);
  assert.match(source, /scroll\.insertBefore\(row, before\)/);
  // 官方行样式是 scoped CSS（.toc-row[data-v-xxxx]），必须复制该属性到注入行
  assert.match(source, /querySelector\('\.toc-row:not\(\.kbm-toc-row\)'\)/);
  assert.match(source, /a\.name\.startsWith\('data-v-'\)/);
  assert.match(source, /row\.setAttribute\(scopeAttr, ''\)/);
  // 收藏绿走扩展自己的 --kbm-* 色板，亮暗跟随 Kimi Web 的 data-color-scheme 主题设置
  assert.match(contentCss, /\.kbm-toc-row \.toc-bar \{ background: var\(--kbm-mark\)/);
  assert.match(contentCss, /--kbm-mark: #ff9500/);
  assert.match(contentCss, /html\[data-color-scheme="dark"\] \{[\s\S]*?--kbm-mark: #ff9f0a/);
});

test('标题提取：优先只取 .msg 正文（footer 时间与按钮不混入）', () => {
  assert.match(source, /anchor\.querySelector\('\.msg'\)/);
  assert.match(source, /clone\.querySelector\('\.a-msg-ft'\)\?\.remove\(\)/);
});

test('收藏页：列表/卡片双视图 + 分组排序 + 批量管理', () => {
  // 视图切换与持久化
  assert.match(source, /data-view="list"/);
  assert.match(source, /data-view="cards"/);
  assert.match(source, /localStorage\.setItem\(\s*VIEW_STORAGE_KEY/);
  // 分组与排序
  assert.match(source, /按会话分组/);
  assert.match(source, /function groupRows\(rows\)/);
  assert.match(source, /kbm-sort-btn/);
  assert.match(source, /最早在前/);
  // 列表行：会话名 + 日期 + 完整内容（pre-wrap 不截断、无左侧星标）
  assert.match(source, /kbm-item-session/);
  assert.match(source, /kbm-item-text/);
  assert.doesNotMatch(source, /kbm-item-star/);
  assert.match(contentCss, /\.kbm-item-text \{[\s\S]*?white-space: pre-wrap/);
  assert.doesNotMatch(contentCss, /\.kbm-item-title/);
  // 卡片视图：统一尺寸网格（非瀑布流）+ 固定 6 行内容区 + 超长渐隐
  assert.match(source, /kbm-card-text/);
  assert.match(source, /kbm-wide kbm-cards/);
  assert.match(contentCss, /\.kbm-wide \{[\s\S]*?width: 100%/);
  assert.match(contentCss, /\.kbm-cards \{[\s\S]*?display: grid[\s\S]*?repeat\(auto-fill, minmax\(260px, 1fr\)\)/);
  assert.doesNotMatch(contentCss, /\.kbm-cards \{\s*columns:/);
  assert.match(contentCss, /\.kbm-card-text \{[\s\S]*?height: 124px/);
  assert.match(contentCss, /\.kbm-card-text\.kbm-clamped \{[\s\S]*?mask-image/);
  assert.match(source, /text\.length > CARD_CLAMP_CHARS \? ' kbm-clamped'/);
  // 空态：文案正式；无收藏时两种视图用同一容器（提示位置完全一致），
  // 卡片网格里的空态占满整行居中
  assert.match(source, /暂无收藏内容。可在 AI 回复下方的操作栏中点击星标，将回复加入收藏。/);
  assert.match(source, /rows\.length === 0 \? 'kbm-wrap'/);
  assert.match(contentCss, /\.kbm-cards \.kbm-empty \{[\s\S]*?grid-column: 1 \/ -1/);
  // 批量管理：管理模式、全选、删除所选
  assert.match(source, /kbm-check-all/);
  assert.match(source, /function deleteSelected\(\)/);
  assert.match(source, /t\('删除所选（\{n\}）', \{ n: selected\.size \}\)/);
});

test('侧栏入口与整页收藏页面', () => {
  assert.match(source, /querySelector\('\.sidebar-actions'\)/);
  assert.match(source, /btn\.className = 'kbm-side-btn'/);
  assert.match(contentCss, /#kbm-page \{[\s\S]*?position: fixed/);
  assert.match(contentCss, /#kbm-page\.open \{ display: flex/);
  // 页面左缘贴侧栏右边线，不遮侧栏
  assert.match(source, /querySelector\('aside\.side'\)/);
  assert.match(source, /getBoundingClientRect\(\)\.right/);
});

test('跳转：同会话滚动 + 加载更早重试；跨会话点行或整页导航接力', () => {
  assert.match(source, /querySelector\('\.top-sentinel-btn'\)/);
  assert.match(source, /JUMP_RETRY_LIMIT/);
  assert.match(source, /scrollIntoView\(\{ block: 'start', behavior: 'smooth' \}\)/);
  assert.match(source, /\[data-session-id="/);
  assert.match(source, /location\.assign\(`\/sessions\/\$\{encodeURIComponent\(sessionId\)\}`\)/);
  assert.match(source, /sessionStorage\.setItem\(PENDING_JUMP_KEY/);
  assert.match(source, /resumePendingJump/);
});

test('回归：星标上色幂等（守卫防 observer 循环），会话切换后重绘', () => {
  // 状态没变不动 DOM（innerHTML 重写会触发 observer，必须挡住）
  assert.match(source, /if \(btn\.dataset\.on === String\(on\)\) return;/);
  // DOM 变化时重绘星标（Vue 重绘气泡后恢复收藏态）
  assert.match(source, /function onMutations\(\) \{[\s\S]*?paintAllStars\(\)/);
  // 路由轮询切会话后主动重绘（observer 触发时可能还是旧会话 id）
  assert.match(source, /export function repaintBookmarkStars\(\)/);
  assert.match(contentJs, /repaintBookmarkStars/);
});

test('详情弹层 markdown 还原：收藏时存渲染后 HTML（消毒），展示包 .msg 上下文', () => {
  // 收藏时存消毒后的渲染 HTML
  assert.match(source, /html: turnHtml\(anchor\)/);
  assert.match(source, /function sanitizeHtml\(node\)/);
  assert.match(source, /querySelectorAll\('script, iframe, object, embed, link, meta, \.a-msg-ft, \.kbm-star'\)/);
  assert.match(source, /attr\.name\.startsWith\('on'\)/);
  assert.match(source, /javascript:/i);
  // 超长不存 HTML（回退纯文本）
  assert.match(source, /html\.length > HTML_LIMIT \? '' : html/);
  // 展示：有 HTML 走 .msg 包裹的 markdown 还原，无则纯文本兜底
  assert.match(source, /<div class="msg kbm-detail-text kbm-md">/);
  assert.match(contentCss, /\.kbm-detail-text\.kbm-md \{[\s\S]*?white-space: normal/);
});

test('生命周期：装配进 content.js，storage 变化联动，销毁清理全部注入物', () => {
  assert.match(contentJs, /import \{[\s\S]*?initBookmarks,[\s\S]*?disposeBookmarks,[\s\S]*?handleBookmarksStorageChanged[\s\S]*?\} from '\.\/content\/bookmarks\.js'/);
  assert.match(contentJs, /handleBookmarksStorageChanged\(changes\)/);
  assert.match(contentJs, /disposeBookmarks\(\)/);
  assert.match(source, /chrome\.storage\.local\.set\(\{ \[BOOKMARKS_STORAGE_KEY\]: store \}\)/);
  assert.equal(BOOKMARKS_STORAGE_KEY, 'kimi-statusbar.bookmarks');
  // 销毁时移除页面、侧栏按钮、星标、目录行
  assert.match(source, /getElementById\('kbm-page'\)\?\.remove\(\)/);
  assert.match(source, /querySelectorAll\('\.kbm-star'\)\) btn\.remove/);
});

test('回归：syncToc 幂等，内容不变不动 DOM（防 MutationObserver 无限循环卡死页面）', () => {
  // 收藏功能挂了全局 MutationObserver，syncToc 若非幂等（每次删除重建目录行），
  // 重建本身又触发 observer → 无限循环。签名一致必须直接 return。
  assert.match(source, /const signature =[\s\S]*?positioned\.map/);
  assert.match(source, /if \(signature === `\$\{scroll\.dataset\.kbmScope\}\|\$\{existing\}`\) return;/);
  // observer 回调先检查销毁与 document 可用性（测试环境 teardown 后仍可能触发一次）
  assert.match(source, /if \(deps\.isDisposed\(\) \|\| typeof document === 'undefined' \|\| !document\.body\) return;/);
});

test('回归：星标与复制按钮完全同款（14px、70% 透明、hover 灰底、间距收紧、简写 tooltip）', () => {
  assert.match(source, /function starSvg\(filled, size = 14\)/);
  assert.match(contentCss, /\.kbm-star \{[\s\S]*?padding: 2px 5px;[\s\S]*?margin: 0 -2px;[\s\S]*?font-size: 14px;[\s\S]*?opacity: 0\.7/);
  assert.match(contentCss, /\.kbm-star svg \{[\s\S]*?display: block/);
  assert.match(contentCss, /\.kbm-star:hover \{ opacity: 1; color: var\(--kbm-text\); background: var\(--kbm-hover\)/);
  assert.match(contentCss, /\.kbm-star\.on \{ color: var\(--kbm-mark\); opacity: 1/);
  // 自绘深色 tooltip，文案从简（收藏 / 取消收藏），不用原生 title
  assert.match(source, /function showTip\(anchorEl, text\)/);
  assert.match(source, /btn\.dataset\.tip = on \? t\('取消收藏'\) : t\('收藏'\)/);
  assert.doesNotMatch(source, /收藏这条回复/);
  assert.doesNotMatch(source, /btn\.title =/);
  assert.match(contentCss, /\.kbm-tip \{[\s\S]*?background: var\(--kbm-text\)[\s\S]*?color: var\(--kbm-bg\)/);
});

test('收藏页布局：内容列 760px 居中（同会话页 --read-max 逻辑）', () => {
  assert.match(contentCss, /\.kbm-wrap \{[\s\S]*?max-width: 760px[\s\S]*?margin: 0 auto/);
  assert.match(source, /<div class="kbm-wrap/);
});

test('分组视图：组间分隔线清晰，组内行不再重复显示会话名', () => {
  // grouped 时行内省略会话名（组头已有），未分组时保留
  assert.match(source, /grouped \? '' : `<span class="kbm-item-session">/);
  assert.match(source, /renderListItem\(row, groupBySession\)/);
  assert.match(source, /renderCardItem\(row, groupBySession\)/);
  // 组间分隔线只在列表视图（卡片视图分组为整行组块 + 嵌套网格，不出分隔线）
  assert.match(contentCss, /\.kbm-wrap \.kbm-group \+ \.kbm-group \{[\s\S]*?border-top: 1px solid var\(--kbm-line\)/);
  assert.match(contentCss, /\.kbm-cards \.kbm-group \{[\s\S]*?grid-column: 1 \/ -1/);
  assert.match(contentCss, /\.kbm-group-head \{[\s\S]*?color: var\(--kbm-text\)/);
});

test('页头分组：无右上角叉号；视图用分段控件；分组/排序/批量管理右列对齐', () => {
  // 页头只有标题与计数
  assert.match(source, /<div class="kbm-page-head"><div class="kbm-wrap">\s*<span class="kbm-page-title">\$\{t\('收藏'\)\}/);
  assert.doesNotMatch(source, /kbm-page-actions/);
  // 分段控件（列表/卡片二选一的观感）
  assert.match(source, /class="kbm-seg-btn\$\{viewMode === 'list' \? ' on' : ''\}"/);
  assert.match(contentCss, /\.kbm-seg \{[\s\S]*?border-radius: 8px/);
  assert.match(contentCss, /\.kbm-seg-btn\.on \{[\s\S]*?background: var\(--kbm-bg\)/);
  // 分组/排序/批量管理在右侧操作列
  assert.match(source, /kbm-toolbar-right[\s\S]*?按会话分组[\s\S]*?kbm-sort-btn[\s\S]*?批量管理/);
  // 管理模式条统一右对齐（与「批量管理」同一右缘，两种视图位置一致）
  assert.match(source, /<div class="kbm-wrap kbm-manage-in">/);
  assert.match(contentCss, /\.kbm-manage-in \{[\s\S]*?justify-content: flex-end/);
});

test('卡片详情弹层：标题 + 用户提问 + 回复全文 + 跳转按钮 + 开合动画', () => {
  // 收藏时记录上一轮用户提问
  assert.match(source, /question: turnQuestion\(anchor\)/);
  assert.match(source, /function turnQuestion\(anchor\)/);
  // 弹层结构
  assert.match(source, /用户提问/);
  assert.doesNotMatch(source, /你的提问/);
  assert.match(source, /kbm-detail-jump">\$\{t\('跳转到原文 →'\)\}/);
  assert.match(source, /#kbm-detail/);
  // 同会话时读实时正文（渲染后 HTML，完整且带 markdown 样式）
  assert.match(source, /const live = turnHtml\(anchor\)/);
  // 列表与卡片点击都打开详情
  assert.match(source, /closest\('\.kbm-item, \.kbm-card'\)/);
  assert.match(source, /if \(row\) openDetail\(row\)/);
  // 开合动画：遮罩淡入 + 卡片上浮缩放
  assert.match(contentCss, /#kbm-detail \{[\s\S]*?transition: opacity 0\.18s/);
  assert.match(contentCss, /#kbm-detail\.open \.kbm-detail-card \{[\s\S]*?transform: none/);
  // 跳转按钮：白字蓝底带兜底色值，字重 500
  assert.match(contentCss, /\.kbm-detail-jump \{[\s\S]*?background: var\(--kbm-accent, #1783ff\) !important;[\s\S]*?color: #ffffff !important;[\s\S]*?font-weight: 500/);
  // Esc 先关详情再关页面；点详情不触发页面关闭
  assert.match(source, /if \(detailRow\) \{\s*closeDetail\(\)/);
  assert.match(source, /closest\('#kbm-page, \.kbm-side-btn, #kbm-detail'\)/);
});

test('回归：侧栏收藏入口与「新建对话/搜索」完全同款（8px 内距、13px/500、16px icon）', () => {
  assert.match(contentCss, /\.kbm-side-btn \{[\s\S]*?margin: 0;[\s\S]*?padding: 8px;[\s\S]*?color: var\(--kbm-text\)[\s\S]*?font-size: 13px;[\s\S]*?font-weight: 500;[\s\S]*?line-height: 1\.25/);
  assert.match(contentCss, /\.kbm-side-btn svg \{[\s\S]*?translateY\(-0\.5px\)/);
  // 侧栏 icon 与官方一致为 16px（消息内星标是 14px）
  assert.match(source, /starSvg\(false, 16\)/);
  // 无 .on 持色逻辑
  assert.doesNotMatch(contentCss, /\.kbm-side-btn\.on/);
  assert.doesNotMatch(source, /kbm-side-btn'\)\?\.classList\.toggle/);
  // 点页面外（切会话/点聊天区）即关闭
  assert.match(source, /function onDocumentClick\(event\)/);
  assert.match(source, /closest\('#kbm-page, \.kbm-side-btn, #kbm-detail'\)/);
  assert.match(source, /document\.addEventListener\('click', onDocumentClick, true\)/);
  // 窄窗口侧栏消失时收藏页 left 重算
  assert.match(source, /window\.addEventListener\('resize', onWindowResize\)/);
});
