/**
 * 面板结构与编辑模式
 *
 * 职责边界：
 * - Widget DOM 的创建/重建/元素缓存（panel.els 的唯一写入方）。
 * - 编辑模式：长按进入、拖拽排序、≡ 菜单配置、Mini 模式、侧栏改造、新手引导。
 * - 状态读 panel-state.js，渲染调 render.js，宠物调 pet-panel.js；
 *   业务动作（刷新/授权/拉取）通过 initWidgetStructure 注入。
 */

import { normalizeWidgetConfig } from '../metrics.js';
import { panel, agentDisplayName, agentModelLabel, quotaPollingWanted } from './panel-state.js';
import { escapeHtml, CONSOLE_URL, SUBSCRIPTION_URL } from './utils.js';
import {
  renderAll,
  renderChart,
  renderPetStats,
  updateBalance,
  updateProgress,
  updateResetText,
  sparkResizeObserver
} from './render.js';
import { petStart, petHandleToggle, petSyncRendering } from './pet-panel.js';
import { start as startWalkthrough } from './walkthrough.js';

export const MINI_STORAGE_KEY = 'kimi-statusbar.mini';
export const ONBOARDED_STORAGE_KEY = 'kimi-statusbar.onboarded';
export const CONFIG_STORAGE_KEY = 'kimi-statusbar.config';

const MODULE_LABELS = {
  header: '标题行',
  input: '输入', cache: '缓存命中', output: '输出', speed: '速度', duration: '上轮耗时',
  quota5h: '5h 额度', quotaWeek: '本周额度', usageChart: '消耗量', pet: '宠物', agents: '子代理',
  external: '外部账户'
  // quotaMonth: '本月额度' —— 暂时下线，见 metrics.js WIDGET_MODULE_IDS 注释
};

// 编辑模式 / 拖拽状态
let editing = false;
let menuModuleId = null;
let longPressStart = null;
let longPressTimer = null;
let dragState = null;
// 长按进入编辑模式后，抑制紧随其后的那次空白 click（否则会进入瞬间又退出）
let suppressExitClick = false;

// 业务动作钩子（由 content.js 在装配时注入）
let deps = {
  isDisposed: () => false,
  manualRefresh: () => {},
  beginOAuth: () => {},
  fetchQuota: () => {},
  fetchExternalProviders: () => {}
};

export function initWidgetStructure(nextDeps) {
  deps = { ...deps, ...nextDeps };
}

/* ---------- Widget DOM ---------- */

function quotaModuleHTML(prefix, label) {
  return `
    <div class="ksb-quota-group">
      <div class="ksb-quota-head">
        <span class="ksb-quota-label">${label}</span>
        <span class="ksb-reset" id="ksb-${prefix}-reset"><span class="ksb-reset-full"></span><span class="ksb-reset-short"></span></span>
        <span class="ksb-quota-pct" id="ksb-${prefix}-pct">--</span>
      </div>
      <div class="ksb-progress" id="ksb-${prefix}-progress"><div class="ksb-progress-fill ksb-low" id="ksb-${prefix}-fill" style="width:0%"></div><span class="ksb-pace" id="ksb-${prefix}-pace" hidden></span></div>
    </div>`;
}

const MODULE_HTML = {
  input: `
    <div class="ksb-stat">
      <span class="ksb-stat-label">输入</span>
      <span class="ksb-stat-value" id="ksb-input-tokens">0</span>
    </div>
    <svg class="ksb-spark ksb-spark-input" id="ksb-input-spark" viewBox="0 0 100 28" preserveAspectRatio="none"></svg>`,
  cache: `
    <div class="ksb-stat">
      <span class="ksb-stat-label">缓存命中</span>
      <span class="ksb-stat-value" id="ksb-cache-pct">--</span>
    </div>
    <svg class="ksb-spark ksb-spark-cache" id="ksb-cache-spark" viewBox="0 0 100 28" preserveAspectRatio="none"></svg>`,
  output: `
    <div class="ksb-stat">
      <span class="ksb-stat-label">输出</span>
      <span class="ksb-stat-value" id="ksb-output-tokens">0</span>
    </div>
    <svg class="ksb-spark ksb-spark-output" id="ksb-output-spark" viewBox="0 0 100 28" preserveAspectRatio="none"></svg>`,
  speed: `
    <div class="ksb-stat">
      <span class="ksb-stat-label">速度<span class="ksb-stat-sub" id="ksb-duration-sub" hidden><span class="ksb-duration-word">上轮</span><span id="ksb-duration-val"></span></span></span>
      <span class="ksb-stat-value" id="ksb-speed-val">--</span>
    </div>
    <svg class="ksb-spark ksb-spark-speed" id="ksb-speed-spark" viewBox="0 0 100 28" preserveAspectRatio="none"></svg>`,
  duration: `
    <div class="ksb-stat">
      <span class="ksb-stat-label">上轮耗时</span>
      <span class="ksb-stat-value" id="ksb-duration-value">--</span>
    </div>
    <svg class="ksb-spark ksb-spark-duration" id="ksb-duration-spark" viewBox="0 0 100 28" preserveAspectRatio="none"></svg>`,
  quota5h: quotaModuleHTML('5h', '5h'),
  quotaWeek: quotaModuleHTML('week', '本周'),
  // quotaMonth: quotaModuleHTML('month', '本月'), —— 暂时下线，见 metrics.js 注释
  pet: `
    <div class="ksb-pet">
      <div class="ksb-pet-clip"><canvas class="ksb-pet-canvas" id="ksb-pet-canvas" width="112" height="112"></canvas></div>
      <div class="ksb-pet-stats">
        <div class="ksb-pet-total-row">
          <span class="ksb-quota-label" id="ksb-pet-label">24h消耗</span>
          <span class="ksb-pet-total" id="ksb-pet-total">--</span>
        </div>
        <span class="ksb-pet-status" id="ksb-pet-status" data-status="idle"><span id="ksb-pet-status-text">空闲</span><span class="ksb-pet-clock" id="ksb-pet-clock" hidden><span id="ksb-pet-clock-num"></span><span id="ksb-pet-ampm"></span></span></span>
      </div>
    </div>`,
  usageChart: `
    <div class="ksb-chart">
      <div class="ksb-chart-head">
        <span class="ksb-quota-label" id="ksb-chart-label">本周消耗</span>
        <span class="ksb-chart-hit"><span class="ksb-chart-hit-full" id="ksb-chart-hit-full"></span><span class="ksb-chart-hit-short" id="ksb-chart-hit-short"></span></span>
      </div>
      <span class="ksb-chart-total" id="ksb-chart-total">--</span>
      <div class="ksb-chart-bars" id="ksb-chart-bars"></div>
    </div>
    <button type="button" class="ksb-cli-lock" id="ksb-cli-lock">
      <span>连接本地 CLI</span><small>开启7d、30d长期统计</small>
    </button>`,
  agents: `
    <div class="ksb-agents">
      <div class="ksb-agents-head">
        <span class="ksb-quota-label">代理</span>
        <span class="ksb-agent-metric m-in">输入</span>
        <span class="ksb-agent-metric m-out">输出</span>
        <span class="ksb-agent-metric m-hit">命中</span>
      </div>
      <div class="ksb-agents-list" id="ksb-agents-list"></div>
    </div>`,
  external: `
    <div class="ksb-stat ksb-external-stat">
      <span class="ksb-stat-label"><span id="ksb-external-title">外部账户</span><span class="ksb-stat-sub" id="ksb-external-sub" hidden></span></span>
      <span class="ksb-stat-value" id="ksb-external-value">--</span>
    </div>
    <div class="ksb-agents ksb-external-full">
      <div class="ksb-agents-head">
        <span class="ksb-quota-label">外部账户</span>
      </div>
      <div class="ksb-external-list" id="ksb-external-list"></div>
    </div>`
};

// 标题行是普通整宽模块，内容随配置（余额显隐、跳转目标）生成
function headerModuleHTML() {
  const toConsole = panel.widgetConfig.modules.header.balanceLink === 'console';
  return `
    <div class="ksb-header">
      <span class="ksb-status-dot ksb-idle" id="ksb-status-dot"></span>
      <span class="ksb-title" title="点击重置并重新拉取数据"><span class="ksb-title-long">Kimi Code</span><span class="ksb-title-brief">Kimi</span></span>
      <span class="ksb-agent-status" id="ksb-agent-status">空闲</span>
      ${panel.widgetConfig.modules.header.showBalance ? `<span class="ksb-balance" id="ksb-balance" title="${toConsole ? '打开 Kimi Code 控制台' : '查看 / 充值额度'}">余额 --</span>` : ''}
    </div>`;
}

function buildModule(id) {
  const module = document.createElement('div');
  module.className = 'ksb-module' + (panel.widgetConfig.modules[id]?.span === 2 ? ' ksb-span-2' : '');
  module.dataset.module = id;
  module.innerHTML = `${id === 'header' ? headerModuleHTML() : MODULE_HTML[id]}<span class="ksb-module-badge" title="模块设置">≡</span>`;
  module.querySelector('.ksb-module-badge').addEventListener('click', (event) => {
    event.stopPropagation();
    if (editing) openModuleMenu(id);
  });
  module.addEventListener('pointerdown', (event) => beginModuleDrag(event, module));
  if (id === 'header') {
    const toConsole = panel.widgetConfig.modules.header.balanceLink === 'console';
    module.querySelector('.ksb-title').addEventListener('click', (event) => {
      event.stopPropagation();
      if (!editing) deps.manualRefresh();
    });
    module.querySelector('.ksb-balance')?.addEventListener('click', (event) => {
      event.stopPropagation();
      if (editing) return;
      window.open(toConsole ? CONSOLE_URL : SUBSCRIPTION_URL, '_blank');
    });
  }
  if (id === 'usageChart') {
    module.querySelector('.ksb-cli-lock')?.addEventListener('click', (event) => {
      event.stopPropagation();
      if (editing) return;
      chrome.runtime.sendMessage({ type: 'cli.usage.open_settings' }).catch(() => {});
    });
  }
  return module;
}

function zoneLabel(text) {
  const label = document.createElement('span');
  label.className = 'ksb-zone-label';
  label.textContent = text;
  return label;
}

function renderRegions(widget) {
  const full = widget.querySelector('.ksb-region-full');
  const mini = widget.querySelector('.ksb-region-mini');
  full.replaceChildren();
  mini.replaceChildren();
  widget.querySelector('.ksb-region-hidden')?.remove();
  // 编辑模式：隐藏区常驻（空也要在才能往里拖），三个区域各带说明文字
  if (editing) {
    const tray = document.createElement('div');
    tray.className = 'ksb-region ksb-region-hidden';
    tray.append(zoneLabel('隐藏区 · 不在面板显示，拖到下方启用'));
    for (const id of panel.widgetConfig.orderHidden) tray.append(buildModule(id));
    widget.insertBefore(tray, full);
    full.append(zoneLabel('展开区 · 展开时显示'));
    mini.append(zoneLabel('固定区 · Mini 也保留'));
  }
  for (const id of panel.widgetConfig.orderFull) full.append(buildModule(id));
  for (const id of panel.widgetConfig.orderMini) mini.append(buildModule(id));
}

// 结构（重建）后重刷全部动态内容；额度/余额/倒计时用缓存值立即回填
export function renderWidgetStructure() {
  const widget = document.getElementById('ksb-widget');
  if (!widget) return;
  renderRegions(widget);
  cacheElements();
  applyModeClasses();
  applySidebarTidy();
  renderAll();
  updateBalance(panel.lastWallet);
  for (const prefix of ['5h', 'week', 'month']) {
    if (panel.lastQuotaPct[prefix] != null) updateProgress(prefix, panel.lastQuotaPct[prefix]);
    updateResetText(prefix, panel.quotaResetAt[prefix]);
  }
  renderChart();
  renderPetStats();
  petStart();
}

// 配置入口：归一化后重建结构；persist 时写入 chrome.storage 供跨页面同步
export function applyWidgetConfig(next, { persist = false } = {}) {
  panel.widgetConfig = normalizeWidgetConfig(next);
  renderWidgetStructure();
  // 额度模块/余额从隐藏恢复可见时立即补一次拉取（background 有 30s 缓存兜底）
  if (quotaPollingWanted()) deps.fetchQuota();
  // 外部账户模块可见时补一次拉取（background 有 60s 缓存兜底）
  if (panel.widgetConfig.modules.external?.show !== 'hidden') deps.fetchExternalProviders();
  if (persist) {
    try {
      chrome.storage.local.set({ [CONFIG_STORAGE_KEY]: panel.widgetConfig }).catch(() => {
        // 存储不可用时配置仅本次会话生效
      });
    } catch (error) {
      // 扩展上下文失效时 chrome API 同步抛错，同样仅本次会话生效
    }
  }
}

export async function loadWidgetConfig() {
  if (deps.isDisposed()) return;
  try {
    const stored = await chrome.storage.local.get(CONFIG_STORAGE_KEY);
    applyWidgetConfig(stored[CONFIG_STORAGE_KEY]);
  } catch (error) {
    console.warn('[Kimi Status] 读取面板配置失败', error);
  }
}

function createWidget() {
  const widget = document.createElement('div');
  widget.id = 'ksb-widget';
  widget.setAttribute('role', 'status');
  widget.addEventListener('click', handleWidgetClick);
  widget.addEventListener('keydown', (event) => {
    if (panel.quotaAuthRequired && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      deps.beginOAuth();
    }
  });
  widget.innerHTML = `
    <div class="ksb-auth-banner" id="ksb-auth-banner" hidden><span class="ksb-auth-banner-text" id="ksb-auth-banner-text">点击完成 Kimi 授权</span><small>授权后显示额度与预警</small></div>
    <div class="ksb-region ksb-region-full"></div>
    <div class="ksb-region ksb-region-mini"></div>
    <div class="ksb-edit-menu" id="ksb-edit-menu" hidden></div>
  `;

  // 底部（迷你）区域整面可点切换模式，含模块间隙；编辑模式与待授权时让位
  widget.querySelector('.ksb-region-mini').addEventListener('click', (event) => {
    event.stopPropagation();
    if (editing || panel.quotaAuthRequired) return;
    toggleMini();
    // 缩放仍随机播放轻动作，但使用独立安全池，排除会让球从无到有蹦出的 in。
    if (panel.widgetConfig.orderMini.includes('pet')) petHandleToggle();
  });
  widget.querySelector('#ksb-edit-menu').addEventListener('click', (event) => {
    event.stopPropagation();
    const opt = event.target.closest('.ksb-menu-opt');
    if (opt && menuModuleId) applyMenuOption(menuModuleId, opt.dataset.kind, opt.dataset.value);
  });
  // 长按进入编辑模式（鼠标/触摸统一走 pointer 事件）
  widget.addEventListener('pointerdown', handleLongPressStart);
  widget.addEventListener('pointerup', cancelLongPress);
  widget.addEventListener('pointercancel', cancelLongPress);
  widget.addEventListener('pointermove', (event) => {
    if (
      longPressStart &&
      Math.hypot(event.clientX - longPressStart.x, event.clientY - longPressStart.y) > 8
    ) cancelLongPress();
  });
  return widget;
}

// 卡片级点击：待授权 → 开始授权；编辑模式点非模块空白 → 退出编辑
function handleWidgetClick(event) {
  // 长按进入编辑模式后紧随松开的那次 click 一律吞掉（不论落在哪）
  if (suppressExitClick) {
    suppressExitClick = false;
    return;
  }
  if (panel.quotaAuthRequired) {
    deps.beginOAuth();
    return;
  }
  if (
    editing &&
    !event.target.closest('.ksb-module') &&
    !event.target.closest('.ksb-edit-menu')
  ) {
    exitEditMode();
  }
}

function cacheElements() {
  const byId = (id) => document.getElementById(id);
  const widget = byId('ksb-widget');
  panel.els = {
    widget,
    statusDot: byId('ksb-status-dot'),
    balance: byId('ksb-balance'),
    authBanner: byId('ksb-auth-banner'),
    authBannerText: byId('ksb-auth-banner-text'),
    regionFull: widget?.querySelector('.ksb-region-full'),
    regionMini: widget?.querySelector('.ksb-region-mini'),
    editMenu: byId('ksb-edit-menu'),
    inputTokens: byId('ksb-input-tokens'),
    outputTokens: byId('ksb-output-tokens'),
    cachePct: byId('ksb-cache-pct'),
    speedVal: byId('ksb-speed-val'),
    durationSub: byId('ksb-duration-sub'),
    durationVal: byId('ksb-duration-val'),
    durationValue: byId('ksb-duration-value'),
    agentStatus: byId('ksb-agent-status'),
    chartLabel: byId('ksb-chart-label'),
    chartTotal: byId('ksb-chart-total'),
    chartHitFull: byId('ksb-chart-hit-full'),
    chartHitShort: byId('ksb-chart-hit-short'),
    chartBars: byId('ksb-chart-bars'),
    agentsList: byId('ksb-agents-list'),
    externalList: byId('ksb-external-list'),
    externalTitle: byId('ksb-external-title'),
    externalValue: byId('ksb-external-value'),
    externalSub: byId('ksb-external-sub'),
    cliLock: byId('ksb-cli-lock'),
    petCanvas: byId('ksb-pet-canvas'),
    petStatus: byId('ksb-pet-status'),
    petStatusText: byId('ksb-pet-status-text'),
    petClock: byId('ksb-pet-clock'),
    petClockNum: byId('ksb-pet-clock-num'),
    petAmpm: byId('ksb-pet-ampm'),
    petLabel: byId('ksb-pet-label'),
    petTotal: byId('ksb-pet-total'),
    sparks: {
      input: byId('ksb-input-spark'),
      output: byId('ksb-output-spark'),
      cache: byId('ksb-cache-spark'),
      speed: byId('ksb-speed-spark'),
      duration: byId('ksb-duration-spark')
    },
    quota: {
      '5h': { fill: byId('ksb-5h-fill'), pace: byId('ksb-5h-pace'), pct: byId('ksb-5h-pct'), reset: byId('ksb-5h-reset') },
      week: { fill: byId('ksb-week-fill'), pace: byId('ksb-week-pace'), pct: byId('ksb-week-pct'), reset: byId('ksb-week-reset') },
      month: { fill: byId('ksb-month-fill'), pace: byId('ksb-month-pace'), pct: byId('ksb-month-pct'), reset: byId('ksb-month-reset') }
    }
  };
}

export function ensureWidget() {
  if (document.getElementById('ksb-widget')) {
    // SPA 可能重建 sidebar，导致缓存的引用失效
    if (!panel.els || !panel.els.widget.isConnected) cacheElements();
    if (panel.els?.widget) sparkResizeObserver.observe(panel.els.widget);
    return true;
  }
  const column = document.querySelector('aside.side > .col');
  if (!column) return false;
  const footer = column.querySelector('.side-footer');
  const widget = createWidget();
  footer ? column.insertBefore(widget, footer) : column.appendChild(widget);
  renderWidgetStructure();
  sparkResizeObserver.observe(widget);
  return true;
}

export function setConnectionHint(text) {
  if (panel.els?.widget) panel.els.widget.title = text || '';
}

/* ---------- Mini 模式 / 侧栏改造 ---------- */

function readMiniMode() {
  try {
    return localStorage.getItem(MINI_STORAGE_KEY) === '1';
  } catch (error) {
    return false;
  }
}

function applyModeClasses() {
  const widget = panel.els?.widget;
  if (!widget) return;
  // 没有沉底模块时 Mini 不可用，退回完整模式（不覆盖用户存储的偏好）
  const miniAvailable = panel.widgetConfig.orderMini.length > 0;
  widget.classList.toggle('ksb-mini', miniAvailable && readMiniMode());
  petSyncRendering();
}

// 侧栏改造（去 logo + 新建对话上移对齐伸缩按钮）总开关，宠物 ≡ 菜单可切；
// 宠物模块隐藏（在灰色区）时改造自动取消
function applySidebarTidy() {
  const pet = panel.widgetConfig.modules.pet;
  const tidy = pet?.sidebarTidy !== false && pet?.show !== 'hidden';
  document.documentElement.classList.toggle('ksb-sidebar-tidy', tidy);
}

function toggleMini() {
  const widget = panel.els?.widget;
  if (!widget || panel.widgetConfig.orderMini.length === 0) return;
  const mini = !widget.classList.contains('ksb-mini');
  try {
    localStorage.setItem(MINI_STORAGE_KEY, mini ? '1' : '0');
  } catch (error) {
    // localStorage 不可用时忽略，Mini 状态仅不持久化
  }
  applyModeClasses();
  setConnectionHint(mini ? 'Mini 模式：点击下方区域展开' : 'Kimi Status 已连接');
}

/* ---------- 编辑模式：长按进入，拖拽排序，角标配置 ---------- */

function handleLongPressStart(event) {
  if (editing || panel.quotaAuthRequired || event.button !== 0) return;
  if (event.target.closest('.ksb-edit-menu')) return;
  cancelLongPress();
  longPressStart = { x: event.clientX, y: event.clientY };
  longPressTimer = setTimeout(() => {
    longPressTimer = null;
    longPressStart = null;
    suppressExitClick = true;
    enterEditMode();
  }, 500);
}

export function cancelLongPress() {
  if (longPressTimer) clearTimeout(longPressTimer);
  longPressTimer = null;
  longPressStart = null;
}

export function enterEditMode() {
  if (!panel.els?.widget) return;
  editing = true;
  panel.els.widget.classList.add('ksb-editing');
  // 重建以挂载顶部隐藏区，隐藏模块在编辑模式下全部可见
  renderWidgetStructure();
  setConnectionHint('编辑模式：拖拽模块排序，点 ≡ 配置，Esc 或点空白处完成');
  document.addEventListener('pointerdown', handleOutsidePointerDown, true);
  document.addEventListener('keydown', handleEditKeydown);
}

export function exitEditMode() {
  editing = false;
  suppressExitClick = false;
  clearDrag();
  menuModuleId = null;
  hideModuleMenu();
  panel.els?.widget?.classList.remove('ksb-editing');
  // 重建以卸下隐藏区，隐藏模块回到不可见
  renderWidgetStructure();
  setConnectionHint('');
  document.removeEventListener('pointerdown', handleOutsidePointerDown, true);
  document.removeEventListener('keydown', handleEditKeydown);
}

export function isEditing() {
  return editing;
}

function handleOutsidePointerDown(event) {
  if (!panel.els?.widget?.contains(event.target)) exitEditMode();
}

function handleEditKeydown(event) {
  if (event.key === 'Escape') exitEditMode();
}

function menuOpts(kind, options, current) {
  const opts = options
    .map(([value, label]) => `<span class="ksb-menu-opt ${String(current) === String(value) ? 'ksb-on' : ''}" data-kind="${kind}" data-value="${value}">${label}</span>`)
    .join('');
  return `<div class="ksb-menu-opts">${opts}</div>`;
}

function moduleMenuHTML(id) {
  if (id === 'header') {
    const header = panel.widgetConfig.modules.header;
    return `
      <div class="ksb-menu-label">标题行 · 余额</div>
      ${menuOpts('showBalance', [[true, '显示'], [false, '隐藏']], header.showBalance)}
      <div class="ksb-menu-label">余额点击跳转</div>
      ${menuOpts('balanceLink', [['subscription', '充值页'], ['console', '控制台']], header.balanceLink)}
    `;
  }
  const mod = panel.widgetConfig.modules[id];
  // 子代理列表模块内容是多行列表，不提供半宽；外部账户提供（半宽显示首个选中账户）
  const widthRow = id === 'agents'
    ? ''
    : `<div class="ksb-menu-label">${MODULE_LABELS[id]} · 宽度</div>
    ${menuOpts('span', [[1, '半宽'], [2, '整宽']], mod.span)}`;
  const agentsRow = id === 'agents'
    ? `<div class="ksb-menu-label">显示代理</div>${agentVisibilityOpts()}`
    : '';
  const externalRow = id === 'external'
    ? `<div class="ksb-menu-label">显示账户</div>${externalVisibilityOpts()}`
    : '';
  const rangeRow = id === 'usageChart'
    ? `<div class="ksb-menu-label">统计范围</div>${menuOpts('chartRange', [['week', '7d'], ['month', '30d']], mod.chartRange)}`
    : '';
  const paceRow = id.startsWith('quota')
    ? `<div class="ksb-menu-label">匀速参照线</div>${menuOpts('pace', [[true, '显示'], [false, '隐藏']], mod.pace)}
      <div class="ksb-menu-label">重置时间显示</div>${menuOpts('resetFormat', [['countdown', '倒计时'], ['absolute', '具体时间']], mod.resetFormat || 'countdown')}`
    : '';
  const statRow = id === 'pet'
    ? `<div class="ksb-menu-label">右侧数据</div>${menuOpts('stat', [['daily', '24h消耗'], ['input', '输入'], ['output', '输出'], ['cache', '缓存命中'], ['speed', '速度'], ['balance', '余额']], mod.stat)}
      <div class="ksb-menu-label">点击小球跳转</div>${menuOpts('ballLink', [['none', '无跳转'], ['console', '控制台'], ['subscription', '充值页']], mod.ballLink || 'none')}
      <div class="ksb-menu-label">侧栏改造（去 logo 上移）</div>${menuOpts('sidebarTidy', [[true, '开启'], [false, '关闭']], mod.sidebarTidy !== false)}`
    : '';
  return `
    ${widthRow}
    ${agentsRow}
    ${externalRow}
    ${statRow}
    ${paceRow}
    ${rangeRow}
  `;
}

// 外部账户模块的显隐开关：每个已配置账户一项，点亮为显示，可连续切换
function externalVisibilityOpts() {
  const hidden = panel.widgetConfig.modules.external?.hiddenAccounts || [];
  if (!panel.externalProviders.length) {
    return '<div class="ksb-menu-opts"><span class="ksb-menu-opt">暂无已配置账户</span></div>';
  }
  const opts = panel.externalProviders
    .map((account) => {
      const visible = !hidden.includes(account.id);
      const label = account.keyTail
        ? `${escapeHtml(account.name)} · ${escapeHtml(account.keyTail)}`
        : escapeHtml(account.name);
      return `<span class="ksb-menu-opt ${visible ? 'ksb-on' : ''}" data-kind="accountToggle" data-value="${escapeHtml(account.id)}">${label}</span>`;
    })
    .join('');
  return `<div class="ksb-menu-opts">${opts}</div>`;
}

// 子代理模块的显隐开关：每个本会话出现过的代理一项（附模型名区分），点亮为显示，可连续切换
function agentVisibilityOpts() {
  const hidden = panel.widgetConfig.modules.agents?.hiddenAgents || [];
  const opts = panel.sessionAgentOrder
    .map((agentId) => {
      const visible = !hidden.includes(agentId);
      const model = agentModelLabel(agentId);
      const label = `${agentDisplayName(agentId)}${model ? ` · ${escapeHtml(model)}` : ''}`;
      return `<span class="ksb-menu-opt ${visible ? 'ksb-on' : ''}" data-kind="agentToggle" data-value="${escapeHtml(agentId)}">${label}</span>`;
    })
    .join('');
  return `<div class="ksb-menu-opts">${opts}</div>`;
}

function openModuleMenu(id) {
  menuModuleId = id;
  const menu = panel.els?.editMenu;
  if (!menu) return;
  menu.innerHTML = moduleMenuHTML(id);
  menu.hidden = false;
  // 锚定到对应模块的角标下方，横向不越出卡片
  const anchor = panel.els.widget.querySelector(`.ksb-module[data-module="${id}"] .ksb-module-badge`);
  if (anchor) {
    const widgetRect = panel.els.widget.getBoundingClientRect();
    const rect = anchor.getBoundingClientRect();
    const belowTop = rect.bottom - widgetRect.top + 4;
    // 卡片贴近屏幕底边，下方放不下时改为向上弹出
    if (belowTop + menu.offsetHeight > widgetRect.height) {
      menu.style.top = `${rect.top - widgetRect.top - menu.offsetHeight - 4}px`;
    } else {
      menu.style.top = `${belowTop}px`;
    }
    menu.style.left = `${Math.max(0, Math.min(rect.left - widgetRect.left, widgetRect.width - menu.offsetWidth - 4))}px`;
  }
}

function hideModuleMenu() {
  if (panel.els?.editMenu) panel.els.editMenu.hidden = true;
}

function applyMenuOption(id, kind, value) {
  const next = JSON.parse(JSON.stringify(panel.widgetConfig));
  if (kind === 'showBalance' || kind === 'balanceLink') {
    next.modules.header[kind] = value === 'true' ? true : value === 'false' ? false : value;
  } else if (kind === 'span') {
    next.modules[id].span = Number(value) === 2 ? 2 : 1;
  } else if (kind === 'pace') {
    next.modules[id].pace = value === 'true';
  } else if (kind === 'resetFormat') {
    next.modules[id].resetFormat = value === 'absolute' ? 'absolute' : 'countdown';
  } else if (kind === 'stat') {
    next.modules[id].stat = value;
  } else if (kind === 'ballLink') {
    next.modules[id].ballLink = value;
  } else if (kind === 'sidebarTidy') {
    next.modules[id].sidebarTidy = value === 'true';
  } else if (kind === 'chartRange') {
    next.modules[id].chartRange = value;
  } else if (kind === 'agentToggle') {
    const hidden = Array.isArray(next.modules.agents.hiddenAgents)
      ? [...next.modules.agents.hiddenAgents]
      : [];
    const index = hidden.indexOf(value);
    if (index >= 0) hidden.splice(index, 1);
    else hidden.push(value);
    next.modules.agents.hiddenAgents = hidden;
  } else if (kind === 'accountToggle') {
    const hidden = Array.isArray(next.modules.external.hiddenAccounts)
      ? [...next.modules.external.hiddenAccounts]
      : [];
    const index = hidden.indexOf(value);
    if (index >= 0) hidden.splice(index, 1);
    else hidden.push(value);
    next.modules.external.hiddenAccounts = hidden;
  }
  applyWidgetConfig(next, { persist: true });
  // 显隐开关支持连续操作：菜单保持打开并刷新勾选状态
  if (kind === 'agentToggle' || kind === 'accountToggle') {
    openModuleMenu(id);
    return;
  }
  // 选项生效后即关闭菜单
  menuModuleId = null;
  hideModuleMenu();
}

function beginModuleDrag(event, moduleEl) {
  if (!editing || event.button !== 0) return;
  if (event.target.closest('.ksb-module-badge')) return;
  event.preventDefault();
  const rect = moduleEl.getBoundingClientRect();
  dragState = {
    el: moduleEl,
    // 固定基准：拖动全程相对原始位置位移、不碰 DOM，松手才落位，避免反馈振荡闪烁
    origLeft: rect.left,
    origTop: rect.top,
    grabX: event.clientX - rect.left,
    grabY: event.clientY - rect.top,
    startX: event.clientX,
    startY: event.clientY,
    active: false
  };
  document.addEventListener('pointermove', handleDragMove);
  document.addEventListener('pointerup', handleDragEnd, { once: true });
  // 触摸/系统手势中断走 pointercancel 而非 pointerup，必须同样兜底
  document.addEventListener('pointercancel', handleDragEnd, { once: true });
}

// 指针所在的区域（纵向最近）：hidden / full / mini
function regionAtPoint(y) {
  const zones = [
    { key: 'hidden', el: panel.els.widget.querySelector('.ksb-region-hidden') },
    { key: 'full', el: panel.els.regionFull },
    { key: 'mini', el: panel.els.regionMini }
  ].filter((zone) => zone.el);
  return zones.reduce((nearest, zone) => {
    const rect = zone.el.getBoundingClientRect();
    const distance = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
    return !nearest || distance < nearest.distance ? { ...zone, distance } : nearest;
  }, null);
}

function handleDragMove(event) {
  if (!dragState) return;
  if (!dragState.active) {
    const moved = Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY);
    if (moved < 5) return;
    dragState.active = true;
    dragState.el.classList.add('ksb-dragging');
    hideModuleMenu();
  }
  dragState.el.style.transform = `translate(${event.clientX - dragState.grabX - dragState.origLeft}px, ${event.clientY - dragState.grabY - dragState.origTop}px)`;
  // 拖到哪个区域就变哪个区域的颜色，落点状态实时预览
  const zone = regionAtPoint(event.clientY)?.key;
  if (zone && zone !== dragState.zone) {
    dragState.zone = zone;
    dragState.el.classList.remove('ksb-drag-to-hidden', 'ksb-drag-to-full', 'ksb-drag-to-mini');
    dragState.el.classList.add(`ksb-drag-to-${zone}`);
  }
}

// 落位（仅松手时执行一次）：区域按指针纵向最近判定，插入点行列感知（空格半宽也可落位）
function placeDraggedModule(x, y) {
  const { el } = dragState;
  const region = regionAtPoint(y)?.el;
  if (!region) return;
  const modules = [...region.children].filter(
    (child) => child !== el && child.classList.contains('ksb-module')
  );
  for (let i = 0; i < modules.length; i++) {
    const child = modules[i];
    const rect = child.getBoundingClientRect();
    // 整行在指针下方 → 插到它前面（含拖到首行上方的情形）
    if (y < rect.top - 6) {
      region.insertBefore(el, child);
      return;
    }
    if (y > rect.bottom + 6) continue; // 行在指针上方，看下一行
    if (x < rect.left + rect.width / 2) {
      region.insertBefore(el, child);
      return;
    }
    // 指针在该模块右半：右侧是空格（下一模块在更靠下的行或不存在）→ 插到它后面补位
    const next = modules[i + 1];
    const nextTop = next ? next.getBoundingClientRect().top : Infinity;
    if (nextTop > rect.top + rect.height / 2) {
      const reference = child.nextSibling;
      if (reference !== el) region.insertBefore(el, reference);
      return;
    }
  }
  region.appendChild(el);
}

// 统一清理拖拽状态与 document 级监听（pointerup/pointercancel/dispose 共用）
export function clearDrag() {
  document.removeEventListener('pointermove', handleDragMove);
  document.removeEventListener('pointerup', handleDragEnd);
  document.removeEventListener('pointercancel', handleDragEnd);
  if (!dragState) return;
  dragState.el.style.transform = '';
  dragState.el.classList.remove('ksb-dragging', 'ksb-drag-to-hidden', 'ksb-drag-to-full', 'ksb-drag-to-mini');
  dragState = null;
}

function handleDragEnd(event) {
  if (!dragState) {
    clearDrag();
    return;
  }
  const { active } = dragState;
  if (active && event) placeDraggedModule(event.clientX, event.clientY);
  clearDrag();
  if (active) commitDragOrder();
}

// 落点即新配置：三个区域的 DOM 顺序读回，跨区域拖动同时改变显隐归属
function commitDragOrder() {
  const next = JSON.parse(JSON.stringify(panel.widgetConfig));
  const readZone = (selector) => [...panel.els.widget.querySelectorAll(`${selector} .ksb-module`)]
    .map((m) => m.dataset.module);
  next.orderFull = readZone('.ksb-region-full');
  next.orderMini = readZone('.ksb-region-mini');
  next.orderHidden = readZone('.ksb-region-hidden');
  for (const id of next.orderFull) next.modules[id].show = 'full';
  for (const id of next.orderMini) next.modules[id].show = 'mini';
  for (const id of next.orderHidden) next.modules[id].show = 'hidden';
  applyWidgetConfig(next, { persist: true });
}

/* ---------- 新手引导 ---------- */

export function maybeShowGuide() {
  if (document.getElementById('ksb-walk')) return;
  // 未授权时由面板顶部的授权横幅引导，授权完成后再进新手引导
  if (panel.quotaAuthRequired) return;
  try {
    if (localStorage.getItem(ONBOARDED_STORAGE_KEY)) return;
  } catch (error) {
    return;
  }
  if (!panel.els?.widget) return;

  const markOnboarded = () => {
    try {
      localStorage.setItem(ONBOARDED_STORAGE_KEY, '1');
    } catch (error) {
      // 写入失败也只影响下次是否再显示
    }
  };

  startWalkthrough({
    steps: [
      {
        title: 'Mini 模式',
        anchor: () => panel.els.widget.querySelector('.ksb-region-mini'),
        bodyHTML: '<b>点最底部这一区域</b>把面板收成一行，再点一次展开。哪些模块留在 Mini 可在编辑模式里调整。'
      },
      {
        title: '宠物',
        anchor: () => panel.els.widget.querySelector('.ksb-module[data-module="pet"]'),
        bodyHTML: '空闲时显示当前<b>时间</b>，工作时自动<b>计时</b>。点小球播一段动画。'
      },
      {
        title: '自定义布局',
        anchor: () => panel.els.widget,
        doneLabel: '完成，进入编辑模式',
        bodyHTML: '<span class="ksb-walk-hl">长按面板任意位置</span>进入编辑模式，拖动模块到不同区域改变显示方式；点模块右上角 <b>≡</b> 调宽度和专属设置。'
          + '<div class="ksb-walk-zones">'
          + '<div class="ksb-walk-zone z-gray"><i></i><span>隐藏区（顶部）· 不在面板显示</span></div>'
          + '<div class="ksb-walk-zone z-blue"><i></i><span>展开区（中间）· 展开时显示</span></div>'
          + '<div class="ksb-walk-zone z-green"><i></i><span>固定区（底部）· Mini 也保留</span></div>'
          + '</div>'
      }
    ],
    onFinish: () => {
      markOnboarded();
      enterEditMode();
    },
    onSkip: markOnboarded
  });
}
