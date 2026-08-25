/**
 * 收藏域（AI 回复书签）
 *
 * 职责边界：
 * - 收藏数据：chrome.storage.local 按会话归档（turnId + 内容摘录 + 时间）。
 * - 收藏入口：AI 回复底部控件行（.a-msg-ft）注入星标按钮。
 * - 展示：右侧目录（.conversation-toc）注入绿色收藏行（复制官方行的 Vue scoped
 *   属性，样式与官方行一致）；侧栏 .sidebar-actions 注入「收藏」入口，点击打开
 *   整页收藏页面（列表/卡片两种视图 + 批量管理）。
 * - 跳转：同会话滚动定位（缺页时自动点「加载更早」有界重试）；跨会话优先点击侧栏
 *   会话行，找不到则整页导航后在目标页续跳（sessionStorage 接力）。
 * - 所有注入点找不到就静默降级，绝不影响页面本身。
 *
 * 状态写 chrome.storage.local（键 BOOKMARKS_STORAGE_KEY），DOM 注入全部带 kbm- 前缀；
 * 由 content.js 装配：initBookmarks / disposeBookmarks / handleBookmarksStorageChanged。
 */

import { t } from '../i18n.js';

export const BOOKMARKS_STORAGE_KEY = 'kimi-statusbar.bookmarks';
const PENDING_JUMP_KEY = 'kbm.pendingJump';
const VIEW_STORAGE_KEY = 'kbm.view';

function saveViewPrefs() {
  try {
    localStorage.setItem(
      VIEW_STORAGE_KEY,
      JSON.stringify({ view: viewMode, group: groupBySession, asc: sortAsc })
    );
  } catch (error) {
    // 视图偏好保存失败不影响使用
  }
}

function loadViewPrefs() {
  try {
    const prefs = JSON.parse(localStorage.getItem(VIEW_STORAGE_KEY) || 'null');
    if (prefs && typeof prefs === 'object') {
      viewMode = prefs.view === 'cards' ? 'cards' : 'list';
      groupBySession = prefs.group === true;
      sortAsc = prefs.asc === true;
      return;
    }
    // 兼容旧的字符串形态
    viewMode = prefs === 'cards' ? 'cards' : 'list';
  } catch (error) {
    viewMode = 'list';
  }
}

// 跳转重试：找不到锚点就点「加载更早」，间隔 700ms，最多 14 次
const JUMP_RETRY_LIMIT = 14;
const JUMP_RETRY_MS = 700;
// 内容摘录上限：收藏本质是本地快照；卡片详情弹层要展示近似全文，给到 4000
const CONTENT_LIMIT = 4000;
// 渲染后 HTML 摘录上限（详情弹层按 markdown 还原用）；超出则不存 HTML，回退纯文本
const HTML_LIMIT = 8000;
// 卡片内容超过这个长度加截断渐隐（配合 CSS 固定 6 行内容区）
const CARD_CLAMP_CHARS = 400;

const STAR_PATH =
  'M12 2.6l2.83 6.1 6.7.56-5.08 4.4 1.5 6.58L12 16.9l-5.95 3.34 1.5-6.58-5.08-4.4 6.7-.56L12 2.6z';

let deps = {
  isDisposed: () => false,
  getSessionId: () => ''
};

// 内存镜像：{ sessions: { [sessionId]: { title, items: { [turnId]: { title, createdAt } } } } }
let store = { sessions: {} };
let observer = null;
let pageOpen = false;
let jumpTimer = null;
// 收藏页视图状态
let viewMode = 'list';
let groupBySession = false;
let sortAsc = false;
let managing = false;
const selected = new Set();

/* ---------- 纯函数（可单测） ---------- */

// 存储结构归一化：坏数据一律回退为空收藏夹
// 会话标题清理：早期版本从侧栏整行 textContent 抓标题，会带上时间徽标（如「历史上的今天 5m」），载入时剥掉
function cleanSessionTitle(title) {
  return String(title || '').replace(/\s+\d+[smhdw]$/, '').trim();
}

export function normalizeBookmarkStore(raw) {
  const sessions = {};
  const src = raw && typeof raw === 'object' ? raw.sessions : null;
  if (!src || typeof src !== 'object') return { sessions };
  for (const [sessionId, entry] of Object.entries(src)) {
    if (!sessionId || !entry || typeof entry !== 'object') continue;
    const items = {};
    const rawItems = entry.items && typeof entry.items === 'object' ? entry.items : {};
    for (const [turnId, item] of Object.entries(rawItems)) {
      if (!turnId || !item || typeof item !== 'object') continue;
      items[turnId] = {
        title: typeof item.title === 'string' ? item.title : '',
        question: typeof item.question === 'string' ? item.question : '',
        html: typeof item.html === 'string' ? item.html : '',
        createdAt: Number.isFinite(item.createdAt) ? item.createdAt : 0
      };
    }
    sessions[sessionId] = {
      title: cleanSessionTitle(entry.title),
      items
    };
  }
  return { sessions };
}

// 收藏标题：压缩空白后截断（与目录 le() 同款思路，纯文本场景）
export function truncateTitle(text, limit = 60) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit)}…`;
}

export function isBookmarked(state, sessionId, turnId) {
  return Boolean(state?.sessions?.[sessionId]?.items?.[turnId]);
}

// 全部收藏拍平为列表（收藏页用）：按收藏时间倒序
export function flattenBookmarks(state) {
  const rows = [];
  for (const [sessionId, entry] of Object.entries(state?.sessions || {})) {
    for (const [turnId, item] of Object.entries(entry.items || {})) {
      rows.push({ sessionId, sessionTitle: entry.title, turnId, ...item });
    }
  }
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

/* ---------- 存储 ---------- */

async function loadStore() {
  try {
    const stored = await chrome.storage.local.get(BOOKMARKS_STORAGE_KEY);
    store = normalizeBookmarkStore(stored[BOOKMARKS_STORAGE_KEY]);
  } catch (error) {
    store = { sessions: {} };
  }
}

async function persist() {
  try {
    await chrome.storage.local.set({ [BOOKMARKS_STORAGE_KEY]: store });
  } catch (error) {
    // 扩展上下文失效等场景：静默失败，下次操作重试
  }
}

/* ---------- DOM 工具 ---------- */

function currentSessionTitle(sessionId) {
  const row = document.querySelector(`[data-session-id="${CSS.escape(sessionId)}"]`);
  // 侧栏会话行里 .t 是标题、.ts 是时间徽标（如 5m）：只取标题，不把时间抓进来
  const titleEl = row?.querySelector('.t');
  const text = (titleEl?.textContent || row?.textContent || '').replace(/\s+/g, ' ').trim();
  return text ? truncateTitle(text, 40) : '';
}

function turnAnchor(turnId) {
  return document.querySelector(`.turn-anchor[data-turn-id="${CSS.escape(turnId)}"]`);
}

// 收藏内容：只取 .msg 正文子节点（footer 的时间/按钮不算）；
// 老版消息没有 .msg 时克隆剔除控件行兜底
function turnTitle(anchor) {
  const body = anchor.querySelector('.msg');
  if (body) return truncateTitle(body.textContent, CONTENT_LIMIT) || t('AI 回复');
  const clone = anchor.cloneNode(true);
  clone.querySelector('.a-msg-ft')?.remove();
  return truncateTitle(clone.textContent, CONTENT_LIMIT) || t('AI 回复');
}

// 该 AI 回复上一轮的用户提问：DOM 顺序里它之前最近的用户轮
function turnQuestion(anchor) {
  const users = [...document.querySelectorAll('.u-bub.turn-anchor[data-turn-id]')];
  const before = users.filter(
    (ua) => ua.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING
  );
  const prev = before[before.length - 1];
  return prev ? truncateTitle(prev.textContent, 300) : '';
}

// 渲染后 HTML（消毒）：剔除脚本/框架/控件与我们的注入物，去掉 on* 事件和
// javascript: 链接。克隆节点自带页面的 class 与 data-v 属性，
// 注入收藏页后 app 自己的样式表直接生效（markdown 标题/加粗/代码块原样还原）
function sanitizeHtml(node) {
  const clone = node.cloneNode(true);
  clone
    .querySelectorAll('script, iframe, object, embed, link, meta, .a-msg-ft, .kbm-star')
    .forEach((el) => el.remove());
  for (const el of [clone, ...clone.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      const isEvent = attr.name.startsWith('on');
      const isJsUrl =
        (attr.name === 'href' || attr.name === 'src') && /^\s*javascript:/i.test(attr.value);
      if (isEvent || isJsUrl) el.removeAttribute(attr.name);
    }
  }
  return clone.innerHTML;
}

// 正文的渲染后 HTML；超长不存（回退纯文本摘录）
function turnHtml(anchor) {
  const body = anchor.querySelector('.msg');
  if (!body) return '';
  const html = sanitizeHtml(body);
  return html.length > HTML_LIMIT ? '' : html;
}

function starSvg(filled, size = 14) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="${STAR_PATH}"/></svg>`;
}

/* 与复制按钮同款的深色小 tooltip（页面 tooltip 是 Vue 组件用不了，自绘同款） */
let tipEl = null;

function showTip(anchorEl, text) {
  hideTip();
  tipEl = document.createElement('div');
  tipEl.className = 'kbm-tip';
  tipEl.textContent = text;
  document.body.append(tipEl);
  const rect = anchorEl.getBoundingClientRect();
  const tipRect = tipEl.getBoundingClientRect();
  tipEl.style.left = `${Math.round(rect.left + rect.width / 2 - tipRect.width / 2)}px`;
  tipEl.style.top = `${Math.round(rect.top - tipRect.height - 6)}px`;
}

function hideTip() {
  tipEl?.remove();
  tipEl = null;
}

function escText(value) {
  const span = document.createElement('span');
  span.textContent = value;
  return span.innerHTML;
}

function dateFmt(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

/* ---------- 收藏开关 ---------- */

async function toggleBookmark(anchor) {
  const sessionId = deps.getSessionId();
  const turnId = anchor?.dataset?.turnId;
  if (!sessionId || !turnId) return;
  const entry = store.sessions[sessionId] || { title: '', items: {} };
  if (entry.items[turnId]) {
    delete entry.items[turnId];
  } else {
    entry.items[turnId] = {
      title: turnTitle(anchor),
      question: turnQuestion(anchor),
      html: turnHtml(anchor),
      createdAt: Date.now()
    };
    if (!entry.title) entry.title = currentSessionTitle(sessionId);
  }
  if (Object.keys(entry.items).length === 0 && !entry.title) delete store.sessions[sessionId];
  else store.sessions[sessionId] = entry;
  await persist();
  syncAll();
}

/* ---------- 注入：AI 回复星标按钮 ---------- */

function decorateTurn(anchor) {
  const footer = anchor.querySelector('.a-msg-ft');
  if (!footer || footer.querySelector('.kbm-star')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'kbm-star';
  btn.setAttribute('aria-label', t('收藏'));
  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    hideTip();
    toggleBookmark(anchor);
  });
  btn.addEventListener('mouseenter', () => showTip(btn, btn.dataset.tip || t('收藏')));
  btn.addEventListener('mouseleave', hideTip);
  footer.append(btn);
  paintStar(anchor);
}

function paintStar(anchor) {
  const btn = anchor.querySelector('.kbm-star');
  if (!btn) return;
  const on = isBookmarked(store, deps.getSessionId(), anchor.dataset.turnId);
  // 幂等：状态没变就不动 DOM（innerHTML 重写会触发 observer，必须挡住）
  if (btn.dataset.on === String(on)) return;
  btn.dataset.on = String(on);
  btn.classList.toggle('on', on);
  btn.innerHTML = starSvg(on);
  btn.dataset.tip = on ? t('取消收藏') : t('收藏');
}

function decorateAllTurns() {
  for (const anchor of document.querySelectorAll('.a-msg.turn-anchor[data-turn-id]')) {
    decorateTurn(anchor);
  }
}

function paintAllStars() {
  for (const anchor of document.querySelectorAll('.a-msg.turn-anchor[data-turn-id]')) {
    paintStar(anchor);
  }
}

/* ---------- 注入：右侧目录绿色收藏行 ---------- */

// 官方目录行的样式是 Vue scoped CSS（.toc-row[data-v-xxxx]），注入行必须带上
// 同一个 scoped 属性才会生效；从现有官方行上现取，版本升级换 hash 也能跟上
function officialScopeAttr(scroll) {
  const official = scroll.querySelector('.toc-row:not(.kbm-toc-row)');
  if (!official) return null;
  const attr = [...official.attributes].find((a) => a.name.startsWith('data-v-'));
  return attr ? attr.name : null;
}

function syncToc() {
  const scroll = document.querySelector('.conversation-toc .toc-scroll');
  if (!scroll) return;
  const sessionId = deps.getSessionId();
  const items = store.sessions[sessionId]?.items || {};
  const rows = Object.entries(items).sort((a, b) => a[1].createdAt - b[1].createdAt);
  const scopeAttr = officialScopeAttr(scroll);
  const officialRows = [...scroll.querySelectorAll('.toc-row:not(.kbm-toc-row)')];
  // 交错定位：官方目录只收用户轮且顺序与会话一致，因此收藏行的插入位置 =
  // 渲染在它之前的用户轮数量。锚点未渲染（历史未分页）的排到最后
  const userAnchors = [...document.querySelectorAll('.u-bub.turn-anchor[data-turn-id]')];
  const positioned = rows.map(([turnId, item]) => {
    const anchor = turnAnchor(turnId);
    let pos = -1;
    if (anchor) {
      pos = userAnchors.filter(
        (ua) => ua.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING
      ).length;
    }
    return { turnId, item, pos };
  });
  positioned.sort((a, b) => (a.pos === -1 ? Infinity : a.pos) - (b.pos === -1 ? Infinity : b.pos));
  // 幂等：内容没变就不动 DOM。本模块挂了 MutationObserver，非幂等的重建会
  // 触发 observer 又重建，无限循环把页面卡死（教训，勿删此判断）
  const signature =
    `${scopeAttr || ''}|` +
    positioned.map((p) => `${p.turnId}:${p.pos}:${truncateTitle(p.item.title, 60)}`).join('');
  const existing = [...scroll.querySelectorAll('.kbm-toc-row')]
    .map((row) => `${row.dataset.turnId}:${row.dataset.pos}:${row.querySelector('.toc-label')?.textContent || ''}`)
    .join('');
  if (signature === `${scroll.dataset.kbmScope}|${existing}`) return;
  scroll.dataset.kbmScope = scopeAttr || '';
  for (const stale of scroll.querySelectorAll('.kbm-toc-row')) stale.remove();
  for (const { turnId, item, pos } of positioned) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'toc-row kbm-toc-row';
    row.dataset.turnId = turnId;
    row.dataset.pos = String(pos);
    const bar = document.createElement('span');
    bar.className = 'toc-bar';
    const label = document.createElement('span');
    label.className = 'toc-label';
    label.textContent = truncateTitle(item.title, 60) || t('AI 回复');
    if (scopeAttr) {
      row.setAttribute(scopeAttr, '');
      bar.setAttribute(scopeAttr, '');
      label.setAttribute(scopeAttr, '');
    }
    row.append(bar, label);
    row.addEventListener('click', () => jumpTo(sessionId, turnId));
    // pos = 之前的用户轮数量 → 插到第 pos 条官方行之前；越界/未定位则追加到末尾
    const before = pos >= 0 && pos < officialRows.length ? officialRows[pos] : null;
    scroll.insertBefore(row, before);
  }
}

/* ---------- 注入：侧栏「收藏」入口 ---------- */

function syncSidebarButton() {
  const actions = document.querySelector('.sidebar-actions');
  if (!actions || actions.querySelector('.kbm-side-btn')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'kbm-side-btn';
  btn.innerHTML = `${starSvg(false, 16)}<span>${t('收藏')}</span>`;
  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    togglePage();
  });
  actions.append(btn);
}

/* ---------- 收藏页面（整页覆盖主区）：列表 / 卡片 / 批量管理 ---------- */

function positionPage() {
  const page = document.getElementById('kbm-page');
  if (!page) return;
  // 覆盖主区但不遮侧栏：左缘贴侧栏右边线；侧栏隐藏（窄窗口）时铺满全宽
  const side = document.querySelector('aside.side');
  const left = side ? Math.round(side.getBoundingClientRect().right) : 0;
  page.style.left = `${left}px`;
}

function togglePage(force) {
  pageOpen = typeof force === 'boolean' ? force : !pageOpen;
  const page = ensurePageDom();
  positionPage();
  page.classList.toggle('open', pageOpen);
  if (pageOpen) renderPage();
}

function onWindowResize() {
  if (pageOpen) positionPage();
}

// 与「新建对话 / 搜索」同为动作入口：点页面外的任何位置（切换会话、点聊天区等）
// 收藏页即关闭，不持有开关状态
function onDocumentClick(event) {
  if (!pageOpen) return;
  const keep = event.target.closest('#kbm-page, .kbm-side-btn, #kbm-detail');
  if (keep) return;
  togglePage(false);
}

function rowKey(sessionId, turnId) {
  return `${sessionId}/${turnId}`;
}

function renderListItem(row, grouped) {
  const key = rowKey(row.sessionId, row.turnId);
  return `
    <div class="kbm-item" data-session-id="${escText(row.sessionId)}" data-turn-id="${escText(row.turnId)}" role="button" tabindex="0">
      ${managing ? `<input type="checkbox" class="kbm-check" data-key="${escText(key)}"${selected.has(key) ? ' checked' : ''}>` : ''}
      <div class="kbm-item-main">
        <div class="kbm-item-meta">
          ${grouped ? '' : `<span class="kbm-item-session">${escText(row.sessionTitle || t('未命名会话'))}</span>`}
          <span class="kbm-item-date">${dateFmt(row.createdAt)}</span>
        </div>
        <div class="kbm-item-text">${escText(row.title || t('AI 回复'))}</div>
      </div>
      ${managing ? '' : `<button type="button" class="kbm-item-remove" data-session-id="${escText(row.sessionId)}" data-turn-id="${escText(row.turnId)}" title="${t('取消收藏')}">✕</button>`}
    </div>`;
}

function renderCardItem(row, grouped) {
  const key = rowKey(row.sessionId, row.turnId);
  const text = row.title || 'AI 回复';
  return `
    <div class="kbm-card" data-session-id="${escText(row.sessionId)}" data-turn-id="${escText(row.turnId)}" role="button" tabindex="0">
      ${managing ? `<input type="checkbox" class="kbm-check" data-key="${escText(key)}"${selected.has(key) ? ' checked' : ''}>` : ''}
      <div class="kbm-card-meta">
        ${grouped ? '' : `<span class="kbm-item-session">${escText(row.sessionTitle || t('未命名会话'))}</span>`}
        <span class="kbm-item-date">${dateFmt(row.createdAt)}</span>
      </div>
      <div class="kbm-card-text${text.length > CARD_CLAMP_CHARS ? ' kbm-clamped' : ''}">${escText(text)}</div>
    </div>`;
}

// 分组：按会话归拢（保持当前排序），组头显示会话名与条数
function groupRows(rows) {
  const groups = [];
  for (const row of rows) {
    let group = groups.find((g) => g.sessionId === row.sessionId);
    if (!group) {
      group = { sessionId: row.sessionId, title: row.sessionTitle || '未命名会话', rows: [] };
      groups.push(group);
    }
    group.rows.push(row);
  }
  return groups;
}

function renderRows(rows) {
  const renderOne = (row) =>
    viewMode === 'cards' ? renderCardItem(row, groupBySession) : renderListItem(row, groupBySession);
  if (!groupBySession) return rows.map(renderOne).join('');
  return groupRows(rows)
    .map(
      (group) => `
        <div class="kbm-group">
          <div class="kbm-group-head">${escText(group.title)}<span class="kbm-page-count">${group.rows.length}</span></div>
          ${group.rows.map(renderOne).join('')}
        </div>`
    )
    .join('');
}

function renderPage() {
  const page = ensurePageDom();
  let rows = flattenBookmarks(store);
  if (sortAsc) rows = [...rows].reverse();
  const manageBar = managing
    ? `<div class="kbm-manage-bar"><div class="kbm-wrap kbm-manage-in">
        <button type="button" class="kbm-delete"${selected.size === 0 ? ' disabled' : ''}>${t('删除所选（{n}）', { n: selected.size })}</button>
        <label class="kbm-select-all"><input type="checkbox" class="kbm-check-all"${selected.size > 0 && selected.size === rows.length ? ' checked' : ''}> ${t('全选')}</label>
        <button type="button" class="kbm-manage-done">${t('完成')}</button>
      </div></div>`
    : '';
  page.innerHTML = `
    <div class="kbm-page-head"><div class="kbm-wrap">
      <span class="kbm-page-title">${t('收藏')}<span class="kbm-page-count">${rows.length}</span></span>
    </div></div>
    <div class="kbm-toolbar"><div class="kbm-wrap kbm-toolbar-in">
      <span class="kbm-seg">
        <button type="button" class="kbm-seg-btn${viewMode === 'list' ? ' on' : ''}" data-view="list">${t('列表')}</button>
        <button type="button" class="kbm-seg-btn${viewMode === 'cards' ? ' on' : ''}" data-view="cards">${t('卡片')}</button>
      </span>
      <span class="kbm-toolbar-right">
        <button type="button" class="kbm-view-btn kbm-group-btn${groupBySession ? ' on' : ''}">${t('按会话分组')}</button>
        <button type="button" class="kbm-view-btn kbm-sort-btn">${sortAsc ? t('最早在前') : t('最新在前')}</button>
        <button type="button" class="kbm-manage">${managing ? t('取消') : t('批量管理')}</button>
      </span>
    </div></div>
    ${manageBar}
    <div class="kbm-page-body"><div class="${rows.length === 0 ? 'kbm-wrap' : viewMode === 'cards' ? 'kbm-wide kbm-cards' : 'kbm-wrap'}">
      ${rows.length === 0 ? `<div class="kbm-empty">${t('暂无收藏内容。可在 AI 回复下方的操作栏中点击星标，将回复加入收藏。')}</div>` : ''}
      ${renderRows(rows)}
    </div></div>`;
}

function ensurePageDom() {
  let page = document.getElementById('kbm-page');
  if (page) return page;
  page = document.createElement('div');
  page.id = 'kbm-page';
  page.setAttribute('role', 'dialog');
  page.setAttribute('aria-label', '收藏');
  document.body.append(page);
  page.addEventListener('click', onPageClick);
  return page;
}

function onPageClick(event) {
  if (event.target.closest('.kbm-close')) {
    togglePage(false);
    return;
  }
  const viewBtn = event.target.closest('.kbm-seg-btn[data-view]');
  if (viewBtn) {
    viewMode = viewBtn.dataset.view === 'cards' ? 'cards' : 'list';
    saveViewPrefs();
    renderPage();
    return;
  }
  if (event.target.closest('.kbm-group-btn')) {
    groupBySession = !groupBySession;
    saveViewPrefs();
    renderPage();
    return;
  }
  if (event.target.closest('.kbm-sort-btn')) {
    sortAsc = !sortAsc;
    saveViewPrefs();
    renderPage();
    return;
  }
  if (event.target.closest('.kbm-manage')) {
    managing = !managing;
    selected.clear();
    renderPage();
    return;
  }
  if (event.target.closest('.kbm-manage-done')) {
    managing = false;
    selected.clear();
    renderPage();
    return;
  }
  if (event.target.closest('.kbm-check-all')) {
    const rows = flattenBookmarks(store);
    const all = selected.size === rows.length;
    selected.clear();
    if (!all) for (const row of rows) selected.add(rowKey(row.sessionId, row.turnId));
    renderPage();
    return;
  }
  if (event.target.closest('.kbm-delete')) {
    deleteSelected();
    return;
  }
  const check = event.target.closest('.kbm-check');
  if (check) {
    event.stopPropagation();
    if (selected.has(check.dataset.key)) selected.delete(check.dataset.key);
    else selected.add(check.dataset.key);
    renderPage();
    return;
  }
  const removeBtn = event.target.closest('.kbm-item-remove');
  if (removeBtn) {
    event.stopPropagation();
    removeBookmark(removeBtn.dataset.sessionId, removeBtn.dataset.turnId);
    return;
  }
  if (managing) return;
  // 列表与卡片视图点击都打开详情弹层
  const target = event.target.closest('.kbm-item, .kbm-card');
  if (target) {
    const row = findRow(target.dataset.sessionId, target.dataset.turnId);
    if (row) openDetail(row);
  }
}

function findRow(sessionId, turnId) {
  return flattenBookmarks(store).find((r) => r.sessionId === sessionId && r.turnId === turnId) || null;
}

/* ---------- 卡片详情弹层（参考搜索弹层：居中卡片 + 遮罩） ---------- */

let detailRow = null;

function ensureDetailDom() {
  let detail = document.getElementById('kbm-detail');
  if (detail) return detail;
  detail = document.createElement('div');
  detail.id = 'kbm-detail';
  detail.setAttribute('role', 'dialog');
  detail.setAttribute('aria-label', t('收藏详情'));
  document.body.append(detail);
  detail.addEventListener('click', (event) => {
    if (event.target === detail || event.target.closest('.kbm-detail-close')) {
      closeDetail();
      return;
    }
    if (event.target.closest('.kbm-detail-jump') && detailRow) {
      jumpTo(detailRow.sessionId, detailRow.turnId);
    }
  });
  return detail;
}

function openDetail(row) {
  detailRow = row;
  const detail = ensureDetailDom();
  let content = row.title || 'AI 回复';
  let contentHtml = row.html || '';
  let question = row.question || '';
  // 同会话且锚点在 DOM：直接读实时正文（渲染后 HTML，完整且带 markdown 样式）
  if (row.sessionId === deps.getSessionId()) {
    const anchor = turnAnchor(row.turnId);
    if (anchor) {
      const live = turnHtml(anchor);
      if (live) contentHtml = live;
      if (!question) question = turnQuestion(anchor);
    }
  }
  // 有渲染后 HTML 走 markdown 还原（包一层 .msg 上下文类，app 的正文样式直接生效）；
  // 没有则回退纯文本摘录
  const contentBlock = contentHtml
    ? `<div class="msg kbm-detail-text kbm-md">${contentHtml}</div>`
    : `<div class="kbm-detail-text">${escText(content)}</div>`;
  detail.innerHTML = `
    <div class="kbm-detail-card">
      <div class="kbm-detail-head">
        <span class="kbm-detail-title">${escText(row.sessionTitle || t('未命名会话'))}</span>
        <button type="button" class="kbm-detail-close" aria-label="${t('[close]关闭')}">✕</button>
      </div>
      <div class="kbm-detail-body">
        <div class="kbm-detail-label">${t('用户提问')}</div>
        <div class="kbm-detail-q">${escText(question || t('（收藏时未记录提问）'))}</div>
        <div class="kbm-detail-label">${t('AI 回复')}</div>
        ${contentBlock}
      </div>
      <div class="kbm-detail-foot">
        <span class="kbm-item-date">${dateFmt(row.createdAt)}</span>
        <button type="button" class="kbm-detail-jump">${t('跳转到原文 →')}</button>
      </div>
    </div>`;
  detail.classList.add('open');
}

function closeDetail() {
  detailRow = null;
  document.getElementById('kbm-detail')?.classList.remove('open');
}

async function removeBookmark(sessionId, turnId) {
  const entry = store.sessions[sessionId];
  if (!entry?.items?.[turnId]) return;
  delete entry.items[turnId];
  if (Object.keys(entry.items).length === 0) delete store.sessions[sessionId];
  await persist();
  syncAll();
}

async function deleteSelected() {
  if (selected.size === 0) return;
  for (const key of selected) {
    const sep = key.indexOf('/');
    const sessionId = key.slice(0, sep);
    const turnId = key.slice(sep + 1);
    const entry = store.sessions[sessionId];
    if (entry?.items) delete entry.items[turnId];
    if (entry && Object.keys(entry.items).length === 0) delete store.sessions[sessionId];
  }
  selected.clear();
  await persist();
  syncAll();
}

/* ---------- 跳转 ---------- */

function clearJump() {
  if (jumpTimer) clearTimeout(jumpTimer);
  jumpTimer = null;
}

function flashAnchor(anchor) {
  anchor.classList.remove('kbm-flash');
  // 强制重启动画
  void anchor.offsetWidth;
  anchor.classList.add('kbm-flash');
  setTimeout(() => anchor.classList.remove('kbm-flash'), 1800);
}

// 锚点不在 DOM（历史消息未分页加载）就点「加载更早」重试
function scrollToTurn(turnId, attempt = 0) {
  if (deps.isDisposed()) return;
  const anchor = turnAnchor(turnId);
  if (anchor) {
    anchor.scrollIntoView({ block: 'start', behavior: 'smooth' });
    flashAnchor(anchor);
    return;
  }
  if (attempt >= JUMP_RETRY_LIMIT) return;
  const loadOlder = document.querySelector('.top-sentinel-btn');
  if (loadOlder) loadOlder.click();
  jumpTimer = setTimeout(() => scrollToTurn(turnId, attempt + 1), JUMP_RETRY_MS);
}

function jumpTo(sessionId, turnId) {
  if (!sessionId || !turnId) return;
  clearJump();
  closeDetail();
  if (sessionId === deps.getSessionId()) {
    togglePage(false);
    scrollToTurn(turnId);
    return;
  }
  // 跨会话：优先点击侧栏对应会话行（最贴近 app 行为）
  const row = document.querySelector(`[data-session-id="${CSS.escape(sessionId)}"]`);
  togglePage(false);
  if (row) {
    row.click();
    waitSessionThenScroll(sessionId, turnId, 0);
    return;
  }
  // 会话行不在当前列表（已完成/归档等）：整页导航，目标页续跳
  try {
    sessionStorage.setItem(PENDING_JUMP_KEY, JSON.stringify({ sessionId, turnId }));
  } catch (error) {
    // sessionStorage 不可用时降级为仅导航
  }
  location.assign(`/sessions/${encodeURIComponent(sessionId)}`);
}

function waitSessionThenScroll(sessionId, turnId, attempt) {
  if (deps.isDisposed()) return;
  if (deps.getSessionId() === sessionId) {
    scrollToTurn(turnId);
    return;
  }
  if (attempt >= 10) return;
  jumpTimer = setTimeout(() => waitSessionThenScroll(sessionId, turnId, attempt + 1), 500);
}

// 整页导航后的续跳：等路由与锚点就绪
function resumePendingJump() {
  let pending = null;
  try {
    pending = JSON.parse(sessionStorage.getItem(PENDING_JUMP_KEY) || 'null');
    sessionStorage.removeItem(PENDING_JUMP_KEY);
  } catch (error) {
    return;
  }
  if (!pending?.turnId) return;
  if (pending.sessionId && deps.getSessionId() !== pending.sessionId) return;
  scrollToTurn(pending.turnId);
}

/* ---------- 汇总同步与生命周期 ---------- */

function syncAll() {
  decorateAllTurns();
  paintAllStars();
  syncToc();
  if (pageOpen) renderPage();
}

function onMutations() {
  // 测试环境 teardown / 扩展销毁后 observer 仍可能触发一次，防御性退出
  if (deps.isDisposed() || typeof document === 'undefined' || !document.body) return;
  // DOM 变化（新消息渲染 / 目录重建 / 侧栏更新 / 会话切换重绘）后幂等重挂
  decorateAllTurns();
  paintAllStars();
  syncToc();
  syncSidebarButton();
}

function onKeydown(event) {
  if (event.key !== 'Escape') return;
  // 详情弹层优先于收藏页关闭
  if (detailRow) {
    closeDetail();
    return;
  }
  if (pageOpen) togglePage(false);
}

export async function initBookmarks(nextDeps) {
  deps = { ...deps, ...nextDeps };
  loadViewPrefs();
  await loadStore();
  ensurePageDom();
  syncAll();
  syncSidebarButton();
  observer = new MutationObserver(onMutations);
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('click', onDocumentClick, true);
  window.addEventListener('resize', onWindowResize);
  // 整页导航（跨会话收藏跳转）后的续跳
  setTimeout(resumePendingJump, 800);
}

// 会话切换后重绘星标（content.js 路由轮询调用）
export function repaintBookmarkStars() {
  if (deps.isDisposed() || typeof document === 'undefined' || !document.body) return;
  paintAllStars();
}

// 语言热切换（content.js 轮询调用）：侧栏按钮、星标 tooltip、收藏页文案重刷
export function refreshBookmarksLocale() {
  if (deps.isDisposed() || typeof document === 'undefined' || !document.body) return;
  const btnLabel = document.querySelector('.kbm-side-btn span');
  if (btnLabel) btnLabel.textContent = t('收藏');
  // 强制重绘星标（tooltip 文案随语言变化；守卫重置后重画）
  for (const star of document.querySelectorAll('.kbm-star')) delete star.dataset.on;
  paintAllStars();
  if (pageOpen) renderPage();
}

export function handleBookmarksStorageChanged(changes) {
  if (!changes[BOOKMARKS_STORAGE_KEY]) return;
  store = normalizeBookmarkStore(changes[BOOKMARKS_STORAGE_KEY].newValue);
  syncAll();
}

export function disposeBookmarks() {
  clearJump();
  closeDetail();
  hideTip();
  if (observer) observer.disconnect();
  observer = null;
  document.removeEventListener('keydown', onKeydown);
  document.removeEventListener('click', onDocumentClick, true);
  window.removeEventListener('resize', onWindowResize);
  document.getElementById('kbm-detail')?.remove();
  document.getElementById('kbm-page')?.remove();
  document.querySelector('.kbm-side-btn')?.remove();
  for (const btn of document.querySelectorAll('.kbm-star')) btn.remove();
  for (const row of document.querySelectorAll('.kbm-toc-row')) row.remove();
  pageOpen = false;
  managing = false;
  selected.clear();
}
