/**
 * Kimi Web Status Widget
 *
 * 职责边界：
 * - 内容脚本：读取当前 Kimi Web 会话、订阅本地 WebSocket、更新 UI。
 * - 扩展后台：请求跨域的 Kimi 额度 API。
 */
(function () {
  'use strict';

  const QUOTA_INTERVAL_MS = 60_000;
  const ROUTE_POLL_INTERVAL_MS = 1_000;
  const WS_RECONNECT_DELAY_MS = 3_000;
  const CREDENTIAL_STORAGE_KEY = 'kimi-web.server-credential';
  const SUBSCRIPTION_URL = 'https://www.kimi.com/membership/subscription?tab=quota';
  const MINI_STORAGE_KEY = 'kimi-statusbar.mini';
  const ONBOARDED_STORAGE_KEY = 'kimi-statusbar.onboarded';
  const CONFIG_STORAGE_KEY = 'kimi-statusbar.config';
  const CONSOLE_URL = 'https://www.kimi.com/code/console';
  // 窗口时长：5h 与 API 的 window.duration=300（分钟）一致；本周按 7 天
  const QUOTA_WINDOW_MS = { '5h': 300 * 60_000, week: 7 * 24 * 3_600_000 };

  // 月度周期按 expireTime 回退一个日历月动态计算（28~31 天随月份变化，不写死 30 天）
  function paceWindowMs(prefix, resetMs) {
    if (prefix === 'month' && Number.isFinite(resetMs)) {
      const start = new Date(resetMs);
      start.setMonth(start.getMonth() - 1);
      return resetMs - start.getTime();
    }
    return QUOTA_WINDOW_MS[prefix];
  }
  const CHART_RANGE_DAYS = { week: 7, month: 30 };
  const CHART_RANGE_LABELS = { week: '7d消耗', month: '30d消耗' };
  // 会话内逐 step 样本（折线图数据源）：只保留最近 40 步
  const SESSION_SAMPLE_LIMIT = 40;
  const MODULE_LABELS = {
    header: '标题行',
    input: '输入', cache: '缓存命中', output: '输出', speed: '速度', duration: '上轮耗时',
    quota5h: '5h 额度', quotaWeek: '本周额度', usageChart: '消耗量', pet: '宠物'
    // quotaMonth: '本月额度' —— 暂时下线，见 metrics.js WIDGET_MODULE_IDS 注释
  };
  const {
    appendSpeedSample,
    boosterBalanceYuan,
    cacheReadPercentage,
    decodeSpeed,
    formatTokenCount,
    listDayKeysBetween,
    medianSpeed,
    normalizeUsage,
    normalizeWidgetConfig,
    quotaPercentage,
    sumUsageBetween,
    totalInputTokens,
    usageDayKey
  } = globalThis.KimiMetrics;

  const STATUS_TEXT = {
    idle: '空闲',
    thinking: '思考中',
    running: '运行中',
    executing: '执行中',
    offline: '未连接',
    unauthorized: '未授权',
    ratelimit: '限流中',
    subagent: '子代理工作中',
    reconnecting: '重连中'
  };

  let token = '';
  let sessionId = '';
  let ws = null;
  let reconnectTimer = null;
  let quotaTimer = null;
  let routeTimer = null;
  let quotaAuthRequired = false;
  let oauthStarting = false;
  let pageActivated = false;
  let disposed = false;
  let lastSeq = 0;
  let sessionRequestId = 0;
  let reconnectAttempts = 0;
  let lastServerErrorLogAt = 0;
  let helloWatchdog = null;

  // 创建 widget 时缓存一次，后续渲染不再重复查询 DOM
  let els = null;

  // 模块配置（chrome.storage.local 加载前先用默认值）
  let widgetConfig = normalizeWidgetConfig(null);
  // 结构重建后用于重绘的动态内容缓存
  const lastQuotaPct = { '5h': null, week: null, month: null };
  let lastWallet = null;
  let usageDailyCache = {};
  // 编辑模式 / 拖拽状态
  let editing = false;
  let menuModuleId = null;
  let longPressStart = null;
  let longPressTimer = null;
  let dragState = null;
  // 长按进入编辑模式后，抑制紧随其后的那次空白 click（否则会进入瞬间又退出）
  let suppressExitClick = false;

  const metrics = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    speedSamples: [],
    lastSpeed: 0,
    lastDuration: 0,
    agentStatus: 'idle'
  };

  // 逐 step 样本：{ input, output, cachePct, speed }，整宽模块的折线图数据源
  let sessionSamples = [];
  // 逐轮耗时样本（上轮耗时模块的折线图数据源）
  let turnDurations = [];

  /* ---------- 格式化 ---------- */

  function fmtDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '--';
    if (ms < 1_000) return `${Math.round(ms)}ms`;
    if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
    return `${(ms / 60_000).toFixed(1)}m`;
  }

  function toNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function progressClass(percentage) {
    if (percentage >= 80) return 'ksb-high';
    if (percentage >= 50) return 'ksb-mid';
    return 'ksb-low';
  }

  /* ---------- 凭据与路由 ---------- */

  function readCredential() {
    try {
      const raw = localStorage.getItem(CREDENTIAL_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return typeof parsed?.credential === 'string' ? parsed.credential : '';
    } catch (error) {
      console.warn('[Kimi Status] 无法读取本地凭据', error);
      return '';
    }
  }

  function getSessionId() {
    return location.pathname.match(/^\/sessions\/([^/?#]+)/)?.[1] || '';
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
      </div>`
  };

  // 标题行是普通整宽模块，内容随配置（余额显隐、跳转目标）生成
  function headerModuleHTML() {
    const toConsole = widgetConfig.modules.header.balanceLink === 'console';
    return `
      <div class="ksb-header">
        <span class="ksb-status-dot ksb-idle" id="ksb-status-dot"></span>
        <span class="ksb-title" title="点击重置并重新拉取数据"><span class="ksb-title-long">Kimi Code</span><span class="ksb-title-brief">Kimi</span></span>
        <span class="ksb-agent-status" id="ksb-agent-status">空闲</span>
        ${widgetConfig.modules.header.showBalance ? `<span class="ksb-balance" id="ksb-balance" title="${toConsole ? '打开 Kimi Code 控制台' : '查看 / 充值额度'}">余额 --</span>` : ''}
      </div>`;
  }

  function buildModule(id) {
    const module = document.createElement('div');
    module.className = 'ksb-module' + (widgetConfig.modules[id]?.span === 2 ? ' ksb-span-2' : '');
    module.dataset.module = id;
    module.innerHTML = `${id === 'header' ? headerModuleHTML() : MODULE_HTML[id]}<span class="ksb-module-badge" title="模块设置">≡</span>`;
    module.querySelector('.ksb-module-badge').addEventListener('click', (event) => {
      event.stopPropagation();
      if (editing) openModuleMenu(id);
    });
    module.addEventListener('pointerdown', (event) => beginModuleDrag(event, module));
    if (id === 'header') {
      const toConsole = widgetConfig.modules.header.balanceLink === 'console';
      module.querySelector('.ksb-title').addEventListener('click', (event) => {
        event.stopPropagation();
        if (!editing) manualRefresh();
      });
      module.querySelector('.ksb-balance')?.addEventListener('click', (event) => {
        event.stopPropagation();
        if (editing) return;
        window.open(toConsole ? CONSOLE_URL : SUBSCRIPTION_URL, '_blank');
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
      for (const id of widgetConfig.orderHidden) tray.append(buildModule(id));
      widget.insertBefore(tray, full);
      full.append(zoneLabel('展开区 · 展开时显示'));
      mini.append(zoneLabel('固定区 · Mini 也保留'));
    }
    for (const id of widgetConfig.orderFull) full.append(buildModule(id));
    for (const id of widgetConfig.orderMini) mini.append(buildModule(id));
  }

  // 结构（重建）后重刷全部动态内容；额度/余额/倒计时用缓存值立即回填
  function renderWidgetStructure() {
    const widget = document.getElementById('ksb-widget');
    if (!widget) return;
    renderRegions(widget);
    cacheElements();
    applyModeClasses();
    applySidebarTidy();
    renderAll();
    updateBalance(lastWallet);
    for (const prefix of ['5h', 'week', 'month']) {
      if (lastQuotaPct[prefix] != null) updateProgress(prefix, lastQuotaPct[prefix]);
      updateResetText(prefix, quotaResetAt[prefix]);
    }
    renderChart();
    renderPetStats();
    petStart();
  }

  // 配置入口：归一化后重建结构；persist 时写入 chrome.storage 供跨页面同步
  function applyWidgetConfig(next, { persist = false } = {}) {
    widgetConfig = normalizeWidgetConfig(next);
    renderWidgetStructure();
    // 额度模块/余额从隐藏恢复可见时立即补一次拉取（background 有 30s 缓存兜底）
    if (quotaPollingWanted()) fetchQuota();
    if (persist) {
      try {
        chrome.storage.local.set({ [CONFIG_STORAGE_KEY]: widgetConfig }).catch(() => {
          // 存储不可用时配置仅本次会话生效
        });
      } catch (error) {
        // 扩展上下文失效时 chrome API 同步抛错，同样仅本次会话生效
      }
    }
  }

  async function loadWidgetConfig() {
    try {
      const stored = await chrome.storage.local.get(CONFIG_STORAGE_KEY);
      applyWidgetConfig(stored[CONFIG_STORAGE_KEY]);
    } catch (error) {
      // 读取失败保持默认配置
    }
  }

  function createWidget() {
    const widget = document.createElement('div');
    widget.id = 'ksb-widget';
    widget.setAttribute('role', 'status');
    widget.addEventListener('click', handleWidgetClick);
    widget.addEventListener('keydown', (event) => {
      if (quotaAuthRequired && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        beginOAuth();
      }
    });
    widget.innerHTML = `
      <div class="ksb-auth-banner" id="ksb-auth-banner" hidden>点击完成 Kimi 授权</div>
      <div class="ksb-region ksb-region-full"></div>
      <div class="ksb-region ksb-region-mini"></div>
      <div class="ksb-edit-menu" id="ksb-edit-menu" hidden></div>
    `;

    // 底部（迷你）区域整面可点切换模式，含模块间隙；编辑模式与待授权时让位
    widget.querySelector('.ksb-region-mini').addEventListener('click', (event) => {
      event.stopPropagation();
      if (editing || quotaAuthRequired) return;
      toggleMini();
      // 宠物在迷你区时，点迷你区也给它一段小动作
      if (widgetConfig.orderMini.includes('pet')) petPlayOnce(petRandomOf(PET_CLICK_ANIMS));
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
    if (quotaAuthRequired) {
      beginOAuth();
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
    els = {
      widget,
      statusDot: byId('ksb-status-dot'),
      balance: byId('ksb-balance'),
      authBanner: byId('ksb-auth-banner'),
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

  function ensureWidget() {
    if (document.getElementById('ksb-widget')) {
      // SPA 可能重建 sidebar，导致缓存的引用失效
      if (!els || !els.widget.isConnected) cacheElements();
      return true;
    }
    const column = document.querySelector('aside.side > .col');
    if (!column) return false;
    const footer = column.querySelector('.side-footer');
    const widget = createWidget();
    footer ? column.insertBefore(widget, footer) : column.appendChild(widget);
    renderWidgetStructure();
    return true;
  }

  function setConnectionHint(text) {
    if (els?.widget) els.widget.title = text || '';
  }

  /* ---------- 交互：手动刷新 / Mini 模式 ---------- */

  function manualRefresh() {
    setConnectionHint('正在刷新…');
    // 手动刷新绕过 background 的 30s 缓存，强制重拉 5h/本周/本月额度
    fetchQuota(true);
    // 手动刷新才显式清零并重拉（自动重建走快照/本地记录裁决，不清零）
    resetMetrics();
    if (sessionId && token) startSession(sessionId);
  }

  function readMiniMode() {
    try {
      return localStorage.getItem(MINI_STORAGE_KEY) === '1';
    } catch (error) {
      return false;
    }
  }

  function applyModeClasses() {
    const widget = els?.widget;
    if (!widget) return;
    // 没有沉底模块时 Mini 不可用，退回完整模式（不覆盖用户存储的偏好）
    const miniAvailable = widgetConfig.orderMini.length > 0;
    widget.classList.toggle('ksb-mini', miniAvailable && readMiniMode());
    petSyncRendering();
  }

  // 侧栏改造（去 logo + 新建对话上移对齐伸缩按钮）总开关，宠物 ≡ 菜单可切；
  // 宠物模块隐藏（在灰色区）时改造自动取消
  function applySidebarTidy() {
    const pet = widgetConfig.modules.pet;
    const tidy = pet?.sidebarTidy !== false && pet?.show !== 'hidden';
    document.documentElement.classList.toggle('ksb-sidebar-tidy', tidy);
  }

  // Mini 折叠时宠物画布高度归 0，Rive 对 0 尺寸画布持续渲染可能卡死页面：
  // 宠物不在迷你区且处于 Mini 时暂停渲染，展开恢复
  function petSyncRendering() {
    if (!petRive) return;
    const petInMini = widgetConfig.orderMini.includes('pet');
    const collapsed = Boolean(els?.widget?.classList.contains('ksb-mini')) && !petInMini;
    try {
      if (collapsed) petRive.stopRendering();
      else petRive.startRendering();
    } catch (error) {
      // 忽略
    }
  }

  function toggleMini() {
    const widget = els?.widget;
    if (!widget || widgetConfig.orderMini.length === 0) return;
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
    if (editing || quotaAuthRequired || event.button !== 0) return;
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

  function cancelLongPress() {
    if (longPressTimer) clearTimeout(longPressTimer);
    longPressTimer = null;
    longPressStart = null;
  }

  function enterEditMode() {
    if (!els?.widget) return;
    editing = true;
    els.widget.classList.add('ksb-editing');
    // 重建以挂载顶部隐藏区，隐藏模块在编辑模式下全部可见
    renderWidgetStructure();
    setConnectionHint('编辑模式：拖拽模块排序，点 ≡ 配置，Esc 或点空白处完成');
    document.addEventListener('pointerdown', handleOutsidePointerDown, true);
    document.addEventListener('keydown', handleEditKeydown);
  }

  function exitEditMode() {
    editing = false;
    suppressExitClick = false;
    clearDrag();
    menuModuleId = null;
    hideModuleMenu();
    els?.widget?.classList.remove('ksb-editing');
    // 重建以卸下隐藏区，隐藏模块回到不可见
    renderWidgetStructure();
    setConnectionHint('');
    document.removeEventListener('pointerdown', handleOutsidePointerDown, true);
    document.removeEventListener('keydown', handleEditKeydown);
  }

  function handleOutsidePointerDown(event) {
    if (!els?.widget?.contains(event.target)) exitEditMode();
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
      const header = widgetConfig.modules.header;
      return `
        <div class="ksb-menu-label">标题行 · 余额</div>
        ${menuOpts('showBalance', [[true, '显示'], [false, '隐藏']], header.showBalance)}
        <div class="ksb-menu-label">余额点击跳转</div>
        ${menuOpts('balanceLink', [['subscription', '充值页'], ['console', '控制台']], header.balanceLink)}
      `;
    }
    const mod = widgetConfig.modules[id];
    const rangeRow = id === 'usageChart'
      ? `<div class="ksb-menu-label">统计范围</div>${menuOpts('chartRange', [['week', '7d'], ['month', '30d']], mod.chartRange)}`
      : '';
    const paceRow = id.startsWith('quota')
      ? `<div class="ksb-menu-label">匀速参照线</div>${menuOpts('pace', [[true, '显示'], [false, '隐藏']], mod.pace)}`
      : '';
    const statRow = id === 'pet'
      ? `<div class="ksb-menu-label">右侧数据</div>${menuOpts('stat', [['daily', '24h消耗'], ['input', '输入'], ['output', '输出'], ['cache', '缓存命中'], ['speed', '速度'], ['balance', '余额']], mod.stat)}
        <div class="ksb-menu-label">点击小球跳转</div>${menuOpts('ballLink', [['none', '无跳转'], ['console', '控制台'], ['subscription', '充值页']], mod.ballLink || 'none')}
        <div class="ksb-menu-label">侧栏改造（去 logo 上移）</div>${menuOpts('sidebarTidy', [[true, '开启'], [false, '关闭']], mod.sidebarTidy !== false)}`
      : '';
    return `
      <div class="ksb-menu-label">${MODULE_LABELS[id]} · 宽度</div>
      ${menuOpts('span', [[1, '半宽'], [2, '整宽']], mod.span)}
      ${statRow}
      ${paceRow}
      ${rangeRow}
    `;
  }

  function openModuleMenu(id) {
    menuModuleId = id;
    const menu = els?.editMenu;
    if (!menu) return;
    menu.innerHTML = moduleMenuHTML(id);
    menu.hidden = false;
    // 锚定到对应模块的角标下方，横向不越出卡片
    const anchor = els.widget.querySelector(`.ksb-module[data-module="${id}"] .ksb-module-badge`);
    if (anchor) {
      const widgetRect = els.widget.getBoundingClientRect();
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
    if (els?.editMenu) els.editMenu.hidden = true;
  }

  function applyMenuOption(id, kind, value) {
    const next = JSON.parse(JSON.stringify(widgetConfig));
    if (kind === 'showBalance' || kind === 'balanceLink') {
      next.modules.header[kind] = value === 'true' ? true : value === 'false' ? false : value;
    } else if (kind === 'span') {
      next.modules[id].span = Number(value) === 2 ? 2 : 1;
    } else if (kind === 'pace') {
      next.modules[id].pace = value === 'true';
    } else if (kind === 'stat') {
      next.modules[id].stat = value;
    } else if (kind === 'ballLink') {
      next.modules[id].ballLink = value;
    } else if (kind === 'sidebarTidy') {
      next.modules[id].sidebarTidy = value === 'true';
    } else if (kind === 'chartRange') {
      next.modules[id].chartRange = value;
    }
    applyWidgetConfig(next, { persist: true });
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
      { key: 'hidden', el: els.widget.querySelector('.ksb-region-hidden') },
      { key: 'full', el: els.regionFull },
      { key: 'mini', el: els.regionMini }
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
  function clearDrag() {
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
    const next = JSON.parse(JSON.stringify(widgetConfig));
    const readZone = (selector) => [...els.widget.querySelectorAll(`${selector} .ksb-module`)]
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

  function maybeShowGuide() {
    if (document.getElementById('ksb-walk')) return;
    // 未授权时由面板顶部的授权横幅引导，授权完成后再进新手引导
    if (quotaAuthRequired) return;
    try {
      if (localStorage.getItem(ONBOARDED_STORAGE_KEY)) return;
    } catch (error) {
      return;
    }
    if (!window.KsbWalkthrough || !els?.widget) return;

    const markOnboarded = () => {
      try {
        localStorage.setItem(ONBOARDED_STORAGE_KEY, '1');
      } catch (error) {
        // 写入失败也只影响下次是否再显示
      }
    };

    window.KsbWalkthrough.start({
      steps: [
        {
          title: 'Mini 模式',
          anchor: () => els.widget.querySelector('.ksb-region-mini'),
          bodyHTML: '<b>点最底部这一区域</b>把面板收成一行，再点一次展开。哪些模块留在 Mini 可在编辑模式里调整。'
        },
        {
          title: '宠物',
          anchor: () => els.widget.querySelector('.ksb-module[data-module="pet"]'),
          bodyHTML: '空闲时显示当前<b>时间</b>，工作时自动<b>计时</b>。点小球播一段动画。'
        },
        {
          title: '自定义布局',
          anchor: () => els.widget,
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

  /* ---------- 渲染 ---------- */

  function updateProgress(prefix, percentage) {
    // 本月用量占比小，保留一位小数；5h/本周保持整数
    const decimals = prefix === 'month' ? 1 : 0;
    const clamped = Math.max(0, Math.min(100, percentage));
    const safePercentage = Number(clamped.toFixed(decimals));
    lastQuotaPct[prefix] = safePercentage;
    const target = els?.quota[prefix];
    if (!target) return;
    const color = progressClass(clamped);
    if (target.fill) {
      target.fill.style.width = `${clamped}%`;
      target.fill.className = `ksb-progress-fill ${color}`;
    }
    if (target.pct) {
      target.pct.textContent = `${safePercentage}%`;
      target.pct.className = `ksb-quota-pct ${color}`;
    }
  }

  function updateBalance(wallet) {
    // undefined 表示“用缓存值重绘”（结构重建后），null/对象则更新缓存
    if (wallet !== undefined) lastWallet = wallet;
    if (!els?.balance) return;
    const balanceYuan = boosterBalanceYuan(lastWallet);
    els.balance.textContent = balanceYuan != null
      ? `¥${balanceYuan.toFixed(2)}`
      : '余额 --';
  }

  function updateTokenDisplay() {
    if (!els) return;
    if (els.inputTokens) els.inputTokens.textContent = formatTokenCount(totalInputTokens(metrics));
    if (els.outputTokens) els.outputTokens.textContent = formatTokenCount(metrics.outputTokens);
  }

  function updateCacheDisplay() {
    if (!els?.cachePct) return;
    const percentage = cacheReadPercentage(metrics);
    els.cachePct.textContent = percentage != null
      ? `${percentage}%`
      : '--';
  }

  function updatePerfDisplay() {
    if (!els) return;
    if (els.speedVal) {
      els.speedVal.textContent = metrics.lastSpeed > 0 ? `${metrics.lastSpeed} tok/s` : '--';
    }
    if (els.durationSub && els.durationVal) {
      if (metrics.lastDuration > 0) {
        els.durationVal.textContent = fmtDuration(metrics.lastDuration);
        els.durationSub.hidden = false;
      } else {
        els.durationSub.hidden = true;
      }
    }
    // 独立的「上轮耗时」模块
    if (els.durationValue) {
      els.durationValue.textContent = metrics.lastDuration > 0 ? fmtDuration(metrics.lastDuration) : '--';
    }
  }

  function setAgentStatus(status) {
    metrics.agentStatus = status;
    if (!els) return;
    // 未授权时状态灯恒红（除非 WS 已断开，优先显示未连接）
    const display = quotaAuthRequired && status !== 'offline' ? 'unauthorized' : status;
    if (els.statusDot) els.statusDot.className = `ksb-status-dot ksb-${display}`;
    if (els.agentStatus) els.agentStatus.textContent = STATUS_TEXT[display] || display;
    petUpdateStatus(display);
  }

  function renderAll() {
    updateTokenDisplay();
    updateCacheDisplay();
    updatePerfDisplay();
    setAgentStatus(metrics.agentStatus);
    renderSparks();
    renderPetStats();
  }

  /* ---------- 会话折线（整宽统计模块） ---------- */

  const SPARK_DEFS = {
    input: { values: () => sessionSamples.map((s) => s.input), fmt: (v) => formatTokenCount(v) },
    output: { values: () => sessionSamples.map((s) => s.output), fmt: (v) => formatTokenCount(v) },
    cache: { values: () => sessionSamples.map((s) => s.cachePct), fmt: (v) => `${Math.round(v)}%` },
    speed: { values: () => sessionSamples.map((s) => s.speed), fmt: (v) => `${v} tok/s` },
    duration: { values: () => turnDurations, fmt: (v) => fmtDuration(v) }
  };

  function renderSparks() {
    if (!els?.sparks) return;
    for (const [id, def] of Object.entries(SPARK_DEFS)) {
      renderSpark(els.sparks[id], def.values(), def.fmt);
    }
  }

  // 100×28 viewBox 的迷你折线：面积淡填充（两端渐隐）+ 折线 + 末点；基线恒含 0
  function renderSpark(svg, values, fmt) {
    if (!svg) return;
    const pts = values.filter((v) => Number.isFinite(v));
    if (!pts.length) {
      svg.replaceChildren();
      return;
    }
    const max = Math.max(...pts);
    const min = Math.min(0, ...pts);
    const range = max - min || 1;
    const W = 100;
    const H = 28;
    const P = 2;
    const n = pts.length;
    const coords = pts.map((v, i) => {
      const x = n === 1 ? W / 2 : P + (i / (n - 1)) * (W - 2 * P);
      const y = H - P - ((v - min) / range) * (H - 2 * P);
      return [x, y];
    });
    const linePoints = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const [lastX, lastY] = coords[n - 1];
    const areaPoints = `${P},${H - P} ${linePoints} ${lastX.toFixed(1)},${H - P}`;
    // 每个样本一组悬浮命中区：整条竖带（对不准点也能触发），悬停显示竖线（上下渐隐）+ 节点圆点 + tooltip
    const spacing = n === 1 ? W - 2 * P : (W - 2 * P) / (n - 1);
    const hits = coords
      .map(([x, y], i) => {
        const fx = x.toFixed(1);
        const fy = y.toFixed(1);
        const rx = Math.max(0, Math.min(W, x - spacing / 2));
        const rw = Math.max(1, Math.min(W, x + spacing / 2) - rx);
        return `<g class="ksb-spark-pt"><line class="ksb-spark-pt-line" x1="${fx}" y1="1" x2="${fx}" y2="27" stroke="url(#${svg.id}-linefade)"/><circle class="ksb-spark-pt-dot" cx="${fx}" cy="${fy}" r="2"/><rect class="ksb-spark-hit" x="${rx.toFixed(1)}" y="0" width="${rw.toFixed(1)}" height="28" fill="transparent"><title>第${i + 1}步 · ${fmt(pts[i])}</title></rect></g>`;
      })
      .join('');
    svg.innerHTML = `
      <defs>
        <linearGradient id="${svg.id}-vfade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="currentColor" stop-opacity="1"/>
          <stop offset="1" stop-color="currentColor" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="${svg.id}-linefade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="currentColor" stop-opacity="0"/>
          <stop offset="0.15" stop-color="currentColor" stop-opacity="1"/>
          <stop offset="0.85" stop-color="currentColor" stop-opacity="1"/>
          <stop offset="1" stop-color="currentColor" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <polygon class="ksb-spark-area" points="${areaPoints}" fill="url(#${svg.id}-vfade)"/>
      <polyline class="ksb-spark-line" points="${linePoints}"/>
      <circle class="ksb-spark-dot" cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="1.6"/>
      ${hits}`;
  }

  /* ---------- 消耗量图表模块 ---------- */

  async function loadUsageDaily() {
    try {
      const stored = await chrome.storage.local.get('usageDaily');
      usageDailyCache = stored.usageDaily || {};
      renderChart();
    } catch (error) {
      // 读取失败保持既有数据
    }
  }

  function renderChart() {
    if (!els?.chartBars || !els.chartTotal) return;
    const range = widgetConfig.modules.usageChart?.chartRange || 'week';
    const days = CHART_RANGE_DAYS[range] || 7;
    const endKey = usageDayKey(new Date());
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - (days - 1));
    const startKey = usageDayKey(startDate);
    const sum = sumUsageBetween(usageDailyCache, startKey, endKey);
    if (els.chartLabel) els.chartLabel.textContent = CHART_RANGE_LABELS[range] || CHART_RANGE_LABELS.week;
    els.chartTotal.textContent = sum.totalTokens > 0 ? formatTokenCount(sum.totalTokens) : '--';
    const hitPct = sum.cacheHitRate != null ? `${Math.round(sum.cacheHitRate * 100)}%` : '';
    if (els.chartHitFull) els.chartHitFull.textContent = hitPct ? `缓存命中 ${hitPct}` : '';
    if (els.chartHitShort) els.chartHitShort.textContent = hitPct;
    els.chartBars.replaceChildren();
    const keys = listDayKeysBetween(startKey, endKey);
    const maxTokens = Math.max(
      0,
      ...keys.map((key) => {
        const bucket = usageDailyCache[key];
        return bucket ? bucket.input + bucket.output : 0;
      })
    );
    for (const key of keys) {
      const bucket = usageDailyCache[key];
      const tokens = bucket ? bucket.input + bucket.output : 0;
      // sub 子桶存在时拆分主/子代理，堆叠展示（主灰在底、子绿在上），与 popup 口径一致
      const subTokens = bucket?.sub ? bucket.sub.input + bucket.sub.output : 0;
      const mainTokens = tokens - subTokens;
      const col = document.createElement('span');
      col.className = 'ksb-chart-col';
      col.title = subTokens > 0
        ? `${key.slice(5)} · 主 ${formatTokenCount(mainTokens)} · 子 ${formatTokenCount(subTokens)}`
        : `${key.slice(5)} · ${formatTokenCount(tokens)}`;
      const stack = document.createElement('span');
      stack.className = 'ksb-chart-stack';
      if (subTokens > 0 && maxTokens > 0) {
        const subBar = document.createElement('span');
        subBar.className = 'ksb-chart-bar sub';
        subBar.style.height = `${(subTokens / maxTokens) * 100}%`;
        stack.append(subBar);
      }
      const mainBar = document.createElement('span');
      mainBar.className = subTokens > 0 ? 'ksb-chart-bar flat' : 'ksb-chart-bar';
      mainBar.style.height = `${Math.max(8, maxTokens > 0 ? (mainTokens / maxTokens) * 100 : 8)}%`;
      stack.append(mainBar);
      col.append(stack);
      els.chartBars.append(col);
    }
  }

  // 宠物模块右侧数据：五种口径可选（≡ 菜单切换），标签与数值联动
  const PET_STAT_DEFS = {
    daily: {
      label: '24h消耗',
      value: () => {
        const bucket = usageDailyCache[usageDayKey(new Date())];
        const total = bucket ? bucket.input + bucket.output : 0;
        return total > 0 ? formatTokenCount(total) : '--';
      }
    },
    input: { label: '输入', value: () => formatTokenCount(totalInputTokens(metrics)) },
    output: { label: '输出', value: () => formatTokenCount(metrics.outputTokens) },
    cache: {
      label: '缓存命中',
      value: () => {
        const pct = cacheReadPercentage(metrics);
        return pct != null ? `${pct}%` : '--';
      }
    },
    speed: {
      label: '速度',
      value: () => (metrics.lastSpeed > 0 ? `${metrics.lastSpeed} tok/s` : '--')
    },
    balance: {
      label: '余额',
      value: () => {
        const yuan = boosterBalanceYuan(lastWallet);
        return yuan != null ? `¥${yuan.toFixed(2)}` : '--';
      }
    }
  };

  function renderPetStats() {
    if (!els?.petTotal) return;
    const def = PET_STAT_DEFS[widgetConfig.modules.pet?.stat] || PET_STAT_DEFS.daily;
    if (els.petLabel) els.petLabel.textContent = def.label;
    els.petTotal.textContent = def.value();
  }

  /* ---------- 宠物模块：Kimi 吉祥物 Rive 动画 ---------- */

  // 资产取自 kimi.com 前端公开 CDN（对话头像），运行时 @rive-app/canvas-lite 本地打包。
  // 该 .riv 状态机默认姿态静止，需 stop() 后手动播放命名动画；UpDown 会越界裁切不可用
  const PET_RIV_URL = chrome.runtime.getURL('rive/kimi_avatar_web-PnsTWI-X.riv');
  const PET_WASM_URL = chrome.runtime.getURL('rive/rive.wasm');
  // 行为模型（用户选定）：空闲 paopao/look_right_stop；思考/运行 loading；
  // 未连接/未授权 history_gary（置灰）；恢复时重建实例（回默认蓝）；
  // 限流 redface（仅一次）；子代理 angrywink；重连 change_dark；
  // 思考/运行结束 stars（仅一次）；点击 yaoyiyao/angryface/in（仅一次）
  const PET_BASE_ANIMS = {
    idle: ['paopao', 'look_right_stop'],
    thinking: ['loading'],
    running: ['loading'],
    executing: ['loading'],
    offline: ['history_gary'],
    unauthorized: ['history_gary'],
    ratelimit: [],
    subagent: ['angrywink'],
    reconnecting: ['change_dark']
  };
  // 点击球/迷你区：一次性小动作随机池（非静帧动画；基底循环动画除外。
  // UpDown / jump / look_forward / look_right 纵向行程会越界或残留位移，已剔除）
  const PET_CLICK_ANIMS = [
    'yaoyiyao', 'angryface', 'in', 'wink', 'stars', 'angryeye',
    'hover', 'hover100', 'wink_stop', 'paopao_stop',
    'history_blue', 'nostars', 'change_light'
  ];
  const PET_DONE_ANIM = 'stars';
  const PET_RATELIMIT_ANIM = 'redface';

  let petRive = null;
  let petCanvasEl = null;
  // 记录点球监听器绑在哪个 canvas 上，实例重建时避免重复绑定
  let petClickBoundCanvas = null;
  let petStatus = 'idle';
  let petBaseTimer = null;
  // 一次性动画播完后是否回基底（常驻 stop 监听读取此标志，见 petStart）
  let petPendingBase = false;
  // 一次性动画的后续链（如 stars → nostars 退场）
  let petChain = [];
  // 状态时钟：进入当前状态的时间点与 1s 计时器
  let petStatusSince = Date.now();
  let petClockTimer = null;

  const PET_CLOCK_STATUSES = ['thinking', 'running', 'executing', 'subagent', 'ratelimit', 'reconnecting'];
  // 一轮回答的组成状态：这些状态之间切换（思考↔执行↔运行↔子代理↔限流）不打断计时
  const PET_ANSWER_STATUSES = ['thinking', 'running', 'executing', 'subagent', 'ratelimit'];

  function petClockStart() {
    if (petClockTimer) return;
    petClockTimer = setInterval(petClockTick, 1_000);
    petClockTick();
  }

  function petClockTick() {
    if (!els?.petClock || !els.petClockNum) return;
    const pad = (n) => String(n).padStart(2, '0');
    if (!PET_CLOCK_STATUSES.includes(petStatus)) {
      // 日常：挂钟（12 小时制 h:MM，AM/PM 独立标签便于窄宽降级）
      const now = new Date();
      const hours = now.getHours();
      const h12 = hours % 12 === 0 ? 12 : hours % 12;
      els.petClock.hidden = false;
      els.petClockNum.textContent = `${h12}:${pad(now.getMinutes())}`;
      if (els.petAmpm) els.petAmpm.textContent = hours < 12 ? 'AM' : 'PM';
      return;
    }
    // 活跃状态：本轮回答（或该状态）的已用时长
    const seconds = Math.floor((Date.now() - petStatusSince) / 1_000);
    const s = seconds % 60;
    const m = Math.floor(seconds / 60) % 60;
    const h = Math.floor(seconds / 3600);
    els.petClock.hidden = false;
    els.petClockNum.textContent = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
    if (els.petAmpm) els.petAmpm.textContent = '';
  }

  function petRandomOf(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  function petPlayMood(name) {
    if (!petRive) return;
    try {
      petRive.stop();
      petRive.play(name);
    } catch (error) {
      // 动画名异常时静默，下一拍再试
    }
  }

  function petPlayBase() {
    petChain = [];
    const anims = PET_BASE_ANIMS[petStatus];
    if (anims?.length) petPlayMood(petRandomOf(anims));
  }

  // 一次性动作：可带后续链（chain 逐段播完再回基底，如 stars → nostars 退场）
  function petPlayOnce(name, { toBase = true, chain = [] } = {}) {
    if (!petRive) return;
    petPendingBase = false;
    petChain = [...chain];
    petPlayMood(name);
    petPendingBase = toBase;
  }

  // 结构重建后调用：canvas 未变且实例存活时复用（避免配置回声造成 Rive 双重实例化）
  function petStart() {
    const api = globalThis.rive;
    if (!api?.Rive || !api?.RuntimeLoader) return;
    if (petRive && els?.petCanvas && els.petCanvas === petCanvasEl) return;
    if (petRive) {
      try {
        petRive.cleanup();
      } catch (error) {
        // 忽略
      }
      petRive = null;
      petCanvasEl = null;
    }
    if (petBaseTimer) clearTimeout(petBaseTimer);
    petBaseTimer = null;
    if (!els?.petCanvas) return;
    // wasm 强制走本地，禁用 CDN 回退（扩展不允许远程代码）
    api.RuntimeLoader.setWasmUrl(PET_WASM_URL);
    api.RuntimeLoader.setWasmFallbackUrl(null);
    petRive = new api.Rive({
      src: PET_RIV_URL,
      canvas: els.petCanvas,
      autoplay: true,
      fit: api.Fit?.Contain,
      alignment: api.Alignment?.Center,
      onLoad: petPlayBase,
      onLoadError: (error) => console.warn('[Kimi Status] 吉祥物动画加载失败', error)
    });
    petCanvasEl = els.petCanvas;
    petSyncRendering();
    petClockStart();
    // 常驻 stop 监听（每个实例只注册一次）：播放列表非空=自家切换，为空=自然播完才推进。
    // 链式段播完后回基底用 setTimeout 跳出同步递归
    try {
      petRive.on('stop', () => {
        // 自家切换（stop+play）时新动画已在播放列表里；只有自然播完列表才为空
        const playing = petRive?.playingAnimationNames;
        if (Array.isArray(playing) && playing.length) return;
        if (petChain.length) {
          petPlayMood(petChain.shift());
          return;
        }
        if (!petPendingBase) return;
        petPendingBase = false;
        setTimeout(petPlayBase, 0);
      });
    } catch (error) {
      // 事件不可用时退回定时器兜底
      petBaseTimer = setTimeout(petPlayBase, 2_500);
    }
    // 点球：播一段一次性小动作；配置了跳转则同时打开（控制台/充值页，≡ 菜单可选）。
    // 同一 canvas 只绑一次：实例重建（灰球恢复）不重复绑定
    if (petClickBoundCanvas !== els.petCanvas) {
      els.petCanvas.addEventListener('click', (event) => {
        event.stopPropagation();
        petPlayOnce(petRandomOf(PET_CLICK_ANIMS));
        const link = widgetConfig.modules.pet?.ballLink;
        if (link === 'console' || link === 'subscription') {
          window.open(link === 'console' ? CONSOLE_URL : SUBSCRIPTION_URL, '_blank');
        }
      });
      petClickBoundCanvas = els.petCanvas;
    }
  }

  // 在同一 canvas 上重建 Rive 实例：history_gary 把球置灰后，.riv 内没有动画
  // 能还原默认蓝（change_light 偏浅，已弃用），只有新实例的默认渲染是正蓝色
  function petRecreate() {
    try {
      petRive?.cleanup();
    } catch (error) {
      // 忽略
    }
    petRive = null;
    petStart();
  }

  // 与状态灯同源：状态行常显文字并变色；状态转变的动画规则：
  // 进入限流 → redface 一次（无基底）；灰球（未授权/未连接）恢复 → 重建实例回默认蓝；
  // 思考/运行结束 → stars 一次后回新基底；其余直接换基底
  function petUpdateStatus(display) {
    if (els?.petStatusText) {
      els.petStatusText.textContent = STATUS_TEXT[display] || display;
      els.petStatus.dataset.status = display;
    }
    if (display === petStatus) return;
    const previous = petStatus;
    petStatus = display;
    // 计时不被工具调用打断：仅在「非回答状态 → 回答状态」或进入非回答状态时重置起点；
    // 思考↔运行↔子代理↔限流之间切换属于同一轮回答，连续计时
    if (PET_ANSWER_STATUSES.includes(display) && !PET_ANSWER_STATUSES.includes(previous)) {
      petStatusSince = Date.now();
    } else if (!PET_ANSWER_STATUSES.includes(display)) {
      petStatusSince = Date.now();
    }
    petClockTick();
    if (display === 'ratelimit') {
      petPlayOnce(PET_RATELIMIT_ANIM, { toBase: false });
    } else if (
      (previous === 'unauthorized' || previous === 'offline') &&
      display !== 'unauthorized' && display !== 'offline'
    ) {
      // 灰球恢复：重建实例，onLoad 自动回当前基底（上面 petStatus 已更新）
      petRecreate();
    } else if ((previous === 'thinking' || previous === 'running') && display === 'idle') {
      // 只在整轮回答结束时庆祝一次；stars 后接 nostars 让星星粒子退场，再回基底
      petPlayOnce(PET_DONE_ANIM, { chain: ['nostars'] });
    } else {
      petPlayBase();
    }
  }

  /* ---------- 额度与授权 ---------- */

  // 额度窗口的重置时间戳（来自 API 的 resetTime，ISO8601）
  const quotaResetAt = { '5h': null, week: null, month: null };
  let resetRefetchTimer = null;

  function parseResetTime(value) {
    const time = Date.parse(value || '');
    return Number.isFinite(time) ? time : null;
  }

  // 紧凑格式（额度行内）：45m / 2h30m / 3d5h，与 macOS 菜单栏应用同精度
  function fmtCountdown(diffMs) {
    const totalMin = Math.floor(diffMs / 60_000);
    if (totalMin < 1) return '即将重置';
    const hours = Math.floor(totalMin / 60);
    const minutes = totalMin % 60;
    if (hours < 1) return `${totalMin}m`;
    const days = Math.floor(hours / 24);
    const restHours = hours % 24;
    if (days >= 1) return `${days}d${restHours ? `${restHours}h` : ''}`;
    return `${hours}h${minutes ? `${minutes}m` : ''}`;
  }

  // 窄宽度下的单单位格式：45m / 2h / 3d
  function fmtCountdownShort(diffMs) {
    const totalMin = Math.floor(diffMs / 60_000);
    if (totalMin < 1) return '即将重置';
    const hours = Math.floor(totalMin / 60);
    if (hours < 1) return `${totalMin}m`;
    const days = Math.floor(hours / 24);
    if (days >= 1) return `${days}d`;
    return `${hours}h`;
  }

  // 完整格式（tooltip）：2小时30分钟后重置（07-23 15:00）
  function fmtCountdownLong(diffMs, resetMs) {
    const totalMin = Math.floor(diffMs / 60_000);
    const date = new Date(resetMs);
    const abs = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    if (totalMin < 1) return '即将重置';
    const hours = Math.floor(totalMin / 60);
    const minutes = totalMin % 60;
    const days = Math.floor(hours / 24);
    const text = days >= 1
      ? `${days}天${hours % 24}小时后重置`
      : hours >= 1
        ? `${hours}小时${minutes}分钟后重置`
        : `${totalMin}分钟后重置`;
    return `${text}（${abs}）`;
  }

  function updateResetText(prefix, resetMs) {
    quotaResetAt[prefix] = resetMs;
    updatePaceTick(prefix);
    const element = els?.quota[prefix]?.reset;
    if (!element) return;
    const full = element.querySelector('.ksb-reset-full');
    const short = element.querySelector('.ksb-reset-short');
    if (!Number.isFinite(resetMs)) {
      if (full) full.textContent = '';
      if (short) short.textContent = '';
      setResetTooltip(prefix, '');
      return;
    }
    const diff = resetMs - Date.now();
    const text = diff > 0 ? fmtCountdown(diff) : '即将重置';
    if (full) full.textContent = text;
    if (short) short.textContent = diff > 0 ? fmtCountdownShort(diff) : '即将重置';
    setResetTooltip(prefix, fmtCountdownLong(Math.max(diff, 0), resetMs));
    // 到点重置后额度必然变化，提前补一次拉取
    if (diff <= 0 && !resetRefetchTimer) {
      resetRefetchTimer = setTimeout(() => {
        resetRefetchTimer = null;
        fetchQuota();
      }, 15_000);
    }
  }

  // 匀速参照：按窗口已流逝比例移动深灰竖标；模块菜单可关闭，resetTime 缺失或剩余异常超过整个窗口时隐藏
  const PACE_MODULE_IDS = { '5h': 'quota5h', week: 'quotaWeek', month: 'quotaMonth' };

  function updatePaceTick(prefix) {
    const tick = els?.quota[prefix]?.pace;
    if (!tick) return;
    if (widgetConfig.modules[PACE_MODULE_IDS[prefix]]?.pace === false) {
      tick.hidden = true;
      return;
    }
    const resetMs = quotaResetAt[prefix];
    const windowMs = paceWindowMs(prefix, resetMs);
    const diff = Number.isFinite(resetMs) ? resetMs - Date.now() : NaN;
    if (!Number.isFinite(diff) || !Number.isFinite(windowMs) || diff > windowMs) {
      tick.hidden = true;
      return;
    }
    const elapsed = Math.max(0, Math.min(1, 1 - diff / windowMs));
    tick.style.left = `${elapsed * 100}%`;
    tick.hidden = false;
  }

  function setResetTooltip(prefix, text) {
    const group = els?.quota[prefix]?.pct?.closest('.ksb-quota-group');
    if (group) group.title = text;
  }

  // 三个额度模块全部隐藏且余额也隐藏时暂停拉取（额度预警通知也随之停用），恢复显示即恢复
  function quotaPollingWanted() {
    const modules = widgetConfig.modules;
    const quotaVisible = ['quota5h', 'quotaWeek'].some(
      (id) => modules[id]?.show !== 'hidden'
    );
    const balanceVisible = modules.header?.show !== 'hidden' && modules.header?.showBalance !== false;
    return quotaVisible || balanceVisible;
  }

  async function fetchQuota(force = false) {
    if (!els?.widget || !chrome?.runtime?.sendMessage) return;
    // 手动强制刷新（点标题）跳过 wanted 检查：全隐藏时也要真的拉
    if (!force && !quotaPollingWanted()) return;
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'quota.fetch',
        payload: { force }
      });
      if (!response?.ok) {
        if (response?.code === 'AUTH_REQUIRED') {
          setQuotaAuthRequired(true);
          return;
        }
        throw new Error(response?.error || '额度请求失败');
      }

      setQuotaAuthRequired(false);
      updateBalance(response.data?.boosterWallet);

      const weeklyPercentage = quotaPercentage(response.data?.usage);
      if (weeklyPercentage != null) updateProgress('week', weeklyPercentage);
      updateResetText('week', parseResetTime(response.data?.usage?.resetTime));

      const fiveHour = response.data?.limits?.find(
        (item) => toNumber(item?.window?.duration) === 300
      );
      const fiveHourPercentage = quotaPercentage(fiveHour?.detail);
      if (fiveHourPercentage != null) updateProgress('5h', fiveHourPercentage);
      updateResetText('5h', parseResetTime(fiveHour?.detail?.resetTime));

      // 月额度暂时下线（background 返回 monthly=null）；模块与拉取逻辑保留备用
    } catch (error) {
      if (String(error?.message || error).includes('Extension context invalidated')) {
        // 扩展已重载，这个残留脚本立即停止所有活动，不再刷错误
        dispose();
        return;
      }
      console.warn('[Kimi Status] 额度更新失败', error);
      setConnectionHint(`额度更新失败：${error.message || error}`);
    }
  }

  function setQuotaAuthRequired(required) {
    quotaAuthRequired = required;
    if (!els?.widget) return;

    els.widget.classList.toggle('ksb-auth-required', required);
    els.widget.tabIndex = required ? 0 : -1;
    els.widget.setAttribute('role', required ? 'button' : 'status');
    if (els.authBanner) {
      els.authBanner.hidden = !required;
      if (required) els.authBanner.textContent = '点击完成 Kimi 授权';
    }
    // 授权状态变化会改变状态灯的显示（未授权恒红 / 恢复后回到真实状态）
    setAgentStatus(metrics.agentStatus);
    setConnectionHint(required ? '点击授权 Kimi 额度查询' : 'Kimi Status 已连接');
    // 授权完成后补一次新手引导（未授权期间引导被推迟）
    if (!required) maybeShowGuide();
  }

  async function beginOAuth() {
    if (!quotaAuthRequired || oauthStarting) return;
    oauthStarting = true;
    try {
      setConnectionHint('正在打开 Kimi 授权页…');
      const response = await chrome.runtime.sendMessage({ type: 'oauth.start' });
      if (!response?.ok) throw new Error(response?.error || '无法开始授权');
      // 轮询由后台 service worker 驱动，授权页完成后自动关闭，面板自动恢复
      if (els.authBanner) {
        els.authBanner.textContent = '授权中，完成后自动恢复';
      }
      setConnectionHint('请在新打开的页面完成授权');
    } catch (error) {
      console.warn('[Kimi Status] 授权启动失败', error);
      setConnectionHint(`授权启动失败：${error.message || error}`);
    } finally {
      oauthStarting = false;
    }
  }

  /* ---------- 会话与 WebSocket ---------- */

  function resetMetrics() {
    metrics.inputTokens = 0;
    metrics.outputTokens = 0;
    metrics.cacheReadTokens = 0;
    metrics.cacheCreationTokens = 0;
    metrics.speedSamples = [];
    metrics.lastSpeed = 0;
    metrics.lastDuration = 0;
    metrics.agentStatus = 'idle';
    lastSeq = 0;
    sessionSamples = [];
    turnDurations = [];
    renderAll();
  }

  async function loadSessionSnapshot(targetSessionId, targetToken, requestId, sessionChanged) {
    if (!targetSessionId || !targetToken) return;
    const stale = () =>
      requestId !== sessionRequestId || targetSessionId !== sessionId || targetToken !== token;
    try {
      const response = await fetch(`/api/v1/sessions/${encodeURIComponent(targetSessionId)}`, {
        headers: { Authorization: `Bearer ${targetToken}` },
        signal: AbortSignal.timeout(15_000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (stale()) return;
      // 快照带 usage：以服务器累计为准
      if (data.usage) {
        const usage = normalizeUsage(data.usage);
        metrics.inputTokens = usage.inputTokens;
        metrics.outputTokens = usage.outputTokens;
        metrics.cacheReadTokens = usage.cacheReadTokens;
        metrics.cacheCreationTokens = usage.cacheCreationTokens;
        metrics.agentStatus = data.busy || data.main_turn_active ? 'running' : 'idle';
        lastSeq = toNumber(data.last_seq);
        renderAll();
        return;
      }
      metrics.agentStatus = data.busy || data.main_turn_active ? 'running' : 'idle';
      lastSeq = toNumber(data.last_seq);
      // 快照没有 usage：回退本地持久化记录，仍没有才按场景处理
      await restoreSessionLocal(targetSessionId, stale, sessionChanged);
    } catch (error) {
      console.warn('[Kimi Status] 会话快照拉取失败，尝试本地持久化记录', error);
      if (!stale()) await restoreSessionLocal(targetSessionId, stale, sessionChanged);
    }
  }

  // 会话重建的本地兜底：background 按 sessionId 持久化的用量记录。
  // 换会话且无记录 → 清零；同会话（credential 轮换等）无记录 → 保留现有累计
  async function restoreSessionLocal(targetSessionId, stale, sessionChanged) {
    let record = null;
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'session.usage.get',
        payload: { sessionId: targetSessionId }
      });
      record = response?.ok ? response.record : null;
    } catch (error) {
      record = null;
    }
    if (stale()) return;
    if (!record) {
      if (sessionChanged) resetMetrics();
      return;
    }
    metrics.inputTokens = toNumber(record.input);
    metrics.outputTokens = toNumber(record.output);
    metrics.cacheReadTokens = toNumber(record.cacheRead);
    metrics.cacheCreationTokens = toNumber(record.cacheCreation);
    metrics.lastDuration = toNumber(record.lastDuration);
    metrics.lastSpeed = 0;
    sessionSamples = Array.isArray(record.steps) ? record.steps.slice(-SESSION_SAMPLE_LIMIT) : [];
    turnDurations = Array.isArray(record.durations) ? record.durations.slice(-SESSION_SAMPLE_LIMIT) : [];
    // 游标只以服务器快照的 last_seq 为准：本地 maxSeq 仅恢复计数器，
    // 抬高游标会吞掉服务器补发的真实新消息
    renderAll();
  }

  function clearHelloWatchdog() {
    if (helloWatchdog) clearTimeout(helloWatchdog);
    helloWatchdog = null;
  }

  function connectWebSocket() {
    if (disposed || !token || !sessionId || ws) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}/api/v1/ws?client_id=kimi-statusbar`;

    try {
      ws = new WebSocket(url, [`kimi-code.bearer.${token}`]);
    } catch (error) {
      console.warn('[Kimi Status] WebSocket 创建失败', error);
      reconnectAttempts += 1;
      scheduleReconnect();
      return;
    }

    // server_hello 看门狗：连接 OPEN 但 hello 永不到达（半开连接）时主动断开走重连
    clearHelloWatchdog();
    helloWatchdog = setTimeout(() => {
      helloWatchdog = null;
      if (ws) {
        setConnectionHint('等待 server_hello 超时，正在重连…');
        try {
          ws.close();
        } catch (error) {
          // 忽略，onclose 会接管
        }
      }
    }, 10_000);

    ws.onmessage = (event) => {
      try {
        handleWsMessage(JSON.parse(event.data));
      } catch (error) {
        console.warn('[Kimi Status] 忽略无法解析的 WebSocket 消息', error);
      }
    };

    ws.onclose = (event) => {
      clearHelloWatchdog();
      ws = null;
      setAgentStatus('reconnecting');
      setConnectionHint(`WebSocket 已断开（${event.code}${event.reason ? `: ${event.reason}` : ''}）`);
      reconnectAttempts += 1;
      scheduleReconnect();
    };

    ws.onerror = () => setConnectionHint('WebSocket 连接失败');
  }

  function scheduleReconnect() {
    if (disposed || reconnectTimer) return;
    // 连续失败超过 6 次：从「重连中」转为「未连接」（仍在后台退避重试）
    if (reconnectAttempts >= 6) setAgentStatus('offline');
    const exponentialDelay = Math.min(
      30_000,
      WS_RECONNECT_DELAY_MS * (2 ** Math.min(reconnectAttempts, 4))
    );
    const delay = Math.round(exponentialDelay * (0.8 + Math.random() * 0.4));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWebSocket();
    }, delay);
  }

  function sendFrame(frame) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  }

  function sendClientHello() {
    sendFrame({
      type: 'client_hello',
      id: `ksb-${Date.now()}`,
      payload: {
        client_id: 'kimi-statusbar',
        subscriptions: [sessionId],
        cursors: { [sessionId]: { seq: lastSeq } }
      }
    });
  }

  function handleWsMessage(message) {
    if (message.type === 'server_hello') {
      clearHelloWatchdog();
      reconnectAttempts = 0;
      setConnectionHint('Kimi Status 已连接');
      // 重连成功后先回到空闲，后续事件（含游标补发的）会把状态修正过来
      if (metrics.agentStatus === 'offline' || metrics.agentStatus === 'reconnecting') {
        setAgentStatus('idle');
      }
      sendClientHello();
      return;
    }

    if (message.type === 'ping') {
      sendFrame({ type: 'pong', payload: { nonce: message.payload?.nonce } });
      return;
    }

    if (message.session_id && message.session_id !== sessionId) return;
    if (message.seq != null) {
      const sequence = Number(message.seq);
      if (Number.isFinite(sequence)) {
        if (sequence <= lastSeq) return;
        lastSeq = sequence;
      }
    }
    const payload = message.payload || {};

    switch (message.type) {
      case 'turn.started':
        setAgentStatus('running');
        break;
      case 'turn.step.started':
        setAgentStatus('thinking');
        break;
      case 'turn.step.completed':
        handleStepCompleted(payload, message.seq, message.agent_id ?? payload.agentId);
        // step 之间的间隙通常在执行工具，用绿色「运行中」和思考（蓝）区分；
        // 子代理的 step 单独显示「子代理工作中」
        setAgentStatus(
          Boolean(message.agent_id ?? payload.agentId) && (message.agent_id ?? payload.agentId) !== 'main'
            ? 'subagent'
            : 'running'
        );
        break;
      case 'tool.call.started':
        // 工具级事件（抓包确认存在）：工具执行期间显示「执行中」
        setAgentStatus('executing');
        break;
      case 'tool.result':
        // 工具返回后回到「思考中」（模型消化结果，直到下一 step 或下一次调用）
        setAgentStatus('thinking');
        break;
      case 'turn.ended':
      case 'turn.completed':
        metrics.lastDuration = toNumber(payload.durationMs ?? payload.duration_ms ?? payload.duration);
        if (metrics.lastDuration > 0) {
          turnDurations.push(metrics.lastDuration);
          if (turnDurations.length > SESSION_SAMPLE_LIMIT) turnDurations.shift();
          // 轮次耗时持久化（background 按 maxTurnSeq 去重）
          const turnSeq = Number(message.seq);
          if (sessionId && Number.isFinite(turnSeq)) {
            chrome.runtime
              .sendMessage({
                type: 'usage.turn',
                payload: { sessionId, seq: turnSeq, durationMs: metrics.lastDuration }
              })
              .catch(() => {});
          }
        }
        setAgentStatus('idle');
        renderAll();
        break;
      case 'event.session.work_changed':
        setAgentStatus(payload.busy || payload.main_turn_active ? 'running' : 'idle');
        break;
      case 'agent.status.updated':
        handleAgentStatus(payload);
        break;
      case 'error': {
        // 供应商限流（429 引擎过载等）是服务器端的瞬时状态，会自动重试，
        // web 界面自有提示；面板显示「限流中」，下一个正常事件会覆盖
        if (payload?.code === 'provider.rate_limit') {
          setAgentStatus('ratelimit');
          break;
        }
        // 其余错误节流记录：60 秒内只记一条，避免刷屏被 Chrome 收集为扩展错误；
        // payload 内联序列化，方便从错误页直接读到内容
        const now = Date.now();
        if (now - lastServerErrorLogAt > 60_000) {
          lastServerErrorLogAt = now;
          console.warn(
            '[Kimi Status] 服务器事件错误',
            JSON.stringify(payload).slice(0, 500)
          );
        }
        break;
      }
    }
  }

  function handleAgentStatus(payload) {
    const status = payload.status || payload.agent_status;
    if (status === 'thinking' || status === 'processing') setAgentStatus('thinking');
    else if (status === 'running' || status === 'working') setAgentStatus('running');
    else if (status === 'idle' || status === 'waiting') setAgentStatus('idle');
  }

  function handleStepCompleted(payload, seq, agentId) {
    const usage = normalizeUsage(payload.usage || payload.token_usage);

    metrics.inputTokens += usage.inputTokens;
    metrics.outputTokens += usage.outputTokens;
    metrics.cacheReadTokens += usage.cacheReadTokens;
    metrics.cacheCreationTokens += usage.cacheCreationTokens;

    const streamDuration = payload.llmStreamDurationMs ?? payload.llmServerDecodeMs;
    const speed = decodeSpeed(usage.outputTokens, streamDuration);

    // 上报给 background 按天累计（popup 消耗量板块）+ 会话级持久化；background 按 sessionId+seq 去重
    // agentId 区分主代理/子代理（'main' 为主代理），speed 供会话折线图样本
    const sequence = Number(seq);
    if (sessionId && Number.isFinite(sequence)) {
      chrome.runtime
        .sendMessage({
          type: 'usage.record',
          payload: {
            sessionId,
            seq: sequence,
            usage,
            dayKey: usageDayKey(new Date()),
            subagent: Boolean(agentId) && agentId !== 'main',
            speed
          }
        })
        .catch(() => {});
    }

    if (speed != null) {
      metrics.speedSamples = appendSpeedSample(metrics.speedSamples, speed);
      metrics.lastSpeed = medianSpeed(metrics.speedSamples);
    } else {
      metrics.lastSpeed = 0;
    }

    // 记录本步样本（折线图）；速度/命中率在本步无法计算时为 null，渲染时跳过
    const stepInput = totalInputTokens(usage);
    sessionSamples.push({
      input: stepInput,
      output: usage.outputTokens,
      cachePct: stepInput > 0 ? (usage.cacheReadTokens / stepInput) * 100 : null,
      speed
    });
    if (sessionSamples.length > SESSION_SAMPLE_LIMIT) sessionSamples.shift();

    renderAll();
  }

  function disconnectWebSocket() {
    clearHelloWatchdog();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectAttempts = 0;
    if (ws) {
      const current = ws;
      ws = null;
      current.onclose = null;
      current.close(1000, 'session changed');
    }
  }

  async function startSession(nextSessionId) {
    const requestId = ++sessionRequestId;
    disconnectWebSocket();
    const sessionChanged = nextSessionId !== sessionId;
    sessionId = nextSessionId;
    if (!sessionId || !token) {
      resetMetrics();
      return;
    }
    if (sessionChanged) {
      // 换会话：折线样本与耗时属旧会话，立即清；计数器等快照/本地记录裁决，不盲目清零
      sessionSamples = [];
      turnDurations = [];
      metrics.lastDuration = 0;
      metrics.lastSpeed = 0;
    }
    const targetToken = token;
    await loadSessionSnapshot(nextSessionId, targetToken, requestId, sessionChanged);
    if (
      !disposed &&
      requestId === sessionRequestId &&
      sessionId === nextSessionId &&
      token === targetToken
    ) connectWebSocket();
  }

  /* ---------- 生命周期 ---------- */

  function activatePage() {
    if (pageActivated || disposed) return;
    pageActivated = true;
    token = readCredential();
    const initialSessionId = getSessionId();
    maybeShowGuide();
    fetchQuota();
    loadWidgetConfig();
    loadUsageDaily();
    startSession(initialSessionId);
    quotaTimer = setInterval(fetchQuota, QUOTA_INTERVAL_MS);
  }

  function checkPageState() {
    // 扩展重载后 chrome.runtime.id 消失，残留脚本自我了断
    if (!chrome?.runtime?.id) {
      dispose();
      return;
    }
    if (!ensureWidget()) return;
    if (!pageActivated) activatePage();

    const nextToken = readCredential();
    const nextSessionId = getSessionId();
    if (nextToken !== token) {
      token = nextToken;
      fetchQuota();
      startSession(nextSessionId);
      return;
    }
    if (nextSessionId !== sessionId) startSession(nextSessionId);
    else if (sessionId && token && !ws && !reconnectTimer) connectWebSocket();
  }

  function handleStorageChanged(changes, area) {
    if (area !== 'local') return;
    // 其他页面写入的配置变化，实时重建面板结构
    if (changes[CONFIG_STORAGE_KEY]) {
      // 配置被删除（popup「重置布局」）：布局回默认，Mini 状态也复位为展开
      if (changes[CONFIG_STORAGE_KEY].newValue === undefined) {
        try {
          localStorage.removeItem(MINI_STORAGE_KEY);
        } catch (error) {
          // 忽略，仅本次保持当前模式
        }
      }
      // storage 回声（本页自己写入的）：配置内容未变则跳过，
      // 否则一次改动会双重建结构 + 双重销毁重建 Rive 实例
      const next = normalizeWidgetConfig(changes[CONFIG_STORAGE_KEY].newValue);
      if (JSON.stringify(next) === JSON.stringify(widgetConfig)) {
        widgetConfig = next;
      } else {
        applyWidgetConfig(next);
      }
    }
    if (changes.usageDaily) {
      usageDailyCache = changes.usageDaily.newValue || {};
      renderChart();
      renderPetStats();
    }
    if (!changes.kimiOnboardingResetAt) return;
    try {
      localStorage.removeItem(ONBOARDED_STORAGE_KEY);
    } catch (error) {
      // 忽略，下次刷新页面仍会显示
    }
    if (pageActivated) {
      maybeShowGuide();
      setQuotaAuthRequired(true);
      updateBalance(null);
    }
  }

  function handleRuntimeMessage(message) {
    if (message?.type === 'auth.completed') fetchQuota();
    if (message?.type === 'auth.cleared') {
      setQuotaAuthRequired(true);
      updateBalance(null);
    }
  }

  function handlePageHide(event) {
    if (event.persisted) {
      disconnectWebSocket();
      return;
    }
    dispose();
  }

  function handlePageShow(event) {
    if (event.persisted && !disposed) checkPageState();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    sessionRequestId += 1;
    cancelLongPress();
    clearDrag();
    if (editing) exitEditMode();
    if (petBaseTimer) clearTimeout(petBaseTimer);
    petBaseTimer = null;
    if (petClockTimer) clearInterval(petClockTimer);
    petClockTimer = null;
    if (petRive) {
      try {
        petRive.cleanup();
      } catch (error) {
        // 忽略
      }
      petRive = null;
      petCanvasEl = null;
    }
    // 侧栏改造的全局 class 一并移除，避免扩展重载后样式残留无法关闭
    document.documentElement.classList.remove('ksb-sidebar-tidy');
    disconnectWebSocket();
    if (quotaTimer) clearInterval(quotaTimer);
    if (routeTimer) clearInterval(routeTimer);
    if (resetRefetchTimer) clearTimeout(resetRefetchTimer);
    // 扩展重载后 Chrome 不会自动重新注入 content script，
    // 残留脚本退出时一并移除 widget，避免留下一个永远灰色的「僵尸面板」
    if (els?.widget) els.widget.remove();
    document.getElementById('ksb-guide')?.remove();
    try {
      chrome.storage.onChanged.removeListener(handleStorageChanged);
      chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
    } catch (error) {
      // 扩展上下文失效时监听器会随上下文一起销毁
    }
    window.removeEventListener('pagehide', handlePageHide);
    window.removeEventListener('pageshow', handlePageShow);
    els = null;
  }

  function init() {
    checkPageState();
    routeTimer = setInterval(checkPageState, ROUTE_POLL_INTERVAL_MS);
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('pageshow', handlePageShow);
    chrome.storage.onChanged.addListener(handleStorageChanged);
    chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
