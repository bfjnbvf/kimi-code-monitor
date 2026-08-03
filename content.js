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
  const TOOL_STATUS_MIN_MS = 1_500;
  const STATUS_MIN_DISPLAY_MS = 1_500;
  const CLI_REFRESH_AFTER_TURN_MS = 1_500;
  const CLI_REFRESH_STALE_MS = 60_000;
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
  // 会话内逐 step 样本（折线图数据源）：只保留最近 50 步
  const SESSION_SAMPLE_LIMIT = 50;
  const MODULE_LABELS = {
    header: '标题行',
    input: '输入', cache: '缓存命中', output: '输出', speed: '速度', duration: '上轮耗时',
    quota5h: '5h 额度', quotaWeek: '本周额度', usageChart: '消耗量', pet: '宠物', agents: '子代理',
    external: '外部账户'
    // quotaMonth: '本月额度' —— 暂时下线，见 metrics.js WIDGET_MODULE_IDS 注释
  };
  const {
    boosterBalanceYuan,
    cacheReadPercentage,
    formatPercentage,
    aggregateSpeed,
    decodeSpeed,
    formatTokenCount,
    listDayKeysBetween,
    normalizeUsage,
    normalizeWidgetConfig,
    quotaPercentage,
    sumUsageBetween,
    toNonNegativeInteger,
    totalInputTokens,
    usageDayKey
  } = globalThis.KimiMetrics;

  const STATUS_TEXT = {
    idle: '空闲',
    thinking: '思考中',
    executing: '调用中',
    replying: '回复中',
    offline: '未连接',
    unauthorized: '未授权',
    ratelimit: '限流中',
    subagent: '子代理工作中'
  };

  // 超过 4 字的状态在宠物模块按语义切两行（不超 6 字），避免挤压右侧时钟
  const STATUS_TEXT_LINES = { subagent: ['子代理', '工作中'] };

  let token = '';
  let sessionId = '';
  let ws = null;
  let reconnectTimer = null;
  let quotaTimer = null;
  let externalTimer = null;
  let routeTimer = null;
  let quotaAuthRequired = false;
  let oauthStarting = false;
  let pageActivated = false;
  let disposed = false;
  let lastSeq = 0;
  // 快照失败时这两个游标只负责避免当前页面已处理事件再次计入 UI，不参与 client_hello。
  // 实测：服务端对过期游标只回 resync_required，从不补发历史事件，
  // 因此会话数据恢复完全依赖「快照 + 本地按会话汇总」，WS 只接实时事件。
  let lastUsageSeq = 0;
  let lastTurnSeq = -1;
  let sessionRequestId = 0;
  let sessionSnapshotPending = false;
  let reconnectAttempts = 0;
  let lastServerErrorLogAt = 0;
  let helloWatchdog = null;
  // 工具调用可能与 step / agent 状态事件交错；在结果返回前保持「执行中」，
  // 避免刚显示就被紧随其后的 running / thinking 覆盖。
  let activeToolCalls = 0;
  let toolStatusUntil = 0;
  let toolStatusTimer = null;
  let deferredWorkStatus = 'thinking';

  // 创建 widget 时缓存一次，后续渲染不再重复查询 DOM
  let els = null;

  // 模块配置（chrome.storage.local 加载前先用默认值）
  let widgetConfig = normalizeWidgetConfig(null);
  // 结构重建后用于重绘的动态内容缓存
  const lastQuotaPct = { '5h': null, week: null, month: null };
  let lastWallet = null;
  let usageDailyCache = {};
  let cliUsageConnected = false;
  let cliRefreshTimer = null;
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
    lastDuration: 0,
    agentStatus: 'idle'
  };

  // 逐 step 样本：{ input, output, cachePct, speed, turnEnd? }，整宽模块的折线图数据源
  let sessionSamples = [];
  // 逐轮耗时样本（上轮耗时模块的折线图数据源）
  let turnDurations = [];

  /* ---------- 按代理统计（子代理总览模块数据源） ---------- */

  function emptyAgentMetric() {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  }

  // 当前会话按代理的计数器；'main' 为主代理，其余为子代理 id（agent-N）
  let agentTotals = { main: emptyAgentMetric() };
  // 子代理显示顺序：按本会话首次出现排序；模型名来自 CLI 扫描的按代理汇总
  let sessionAgentOrder = ['main'];
  let agentTopModels = {};
  // CLI 配置里的次级模型真名（config.toml [secondary_model]，需授权 .kimi-code 根目录）
  let secondaryModelName = '';
  // 正在工作中的子代理（subagent.* 生命周期事件维护）
  const activeSubagents = new Set();

  function registerSessionAgent(agentId) {
    if (!agentTotals[agentId]) {
      agentTotals[agentId] = emptyAgentMetric();
      sessionAgentOrder.push(agentId);
    }
  }

  // 显示名：主代理 / 子代理 1 / 子代理 2…（按本会话首次出现顺序）
  function agentDisplayName(agentId) {
    if (agentId === 'main') return '主代理';
    const index = sessionAgentOrder.indexOf(agentId);
    return index > 0 ? `子代理 ${index}` : '子代理';
  }

  function agentModelLabel(agentId) {
    let model = agentTopModels[agentId];
    // 子代理的 usage 记录只有 __secondary__ 占位符：用 CLI 配置里的真实次级模型名
    if (model === '__secondary__') model = secondaryModelName || '';
    if (!model) return '';
    // 去掉 kimi-code/ 与 kimi- 前缀，窄面板里尽量多保留可辨识部分
    return String(model).replace(/^kimi-code\//, '').replace(/^kimi-/, '');
  }

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
    // 外部账户模块可见时补一次拉取（background 有 60s 缓存兜底）
    if (widgetConfig.modules.external?.show !== 'hidden') fetchExternalProviders();
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
      <div class="ksb-auth-banner" id="ksb-auth-banner" hidden><span class="ksb-auth-banner-text" id="ksb-auth-banner-text">点击完成 Kimi 授权</span><small>授权后显示 5h / 本周额度、余额与超额预警</small></div>
      <div class="ksb-region ksb-region-full"></div>
      <div class="ksb-region ksb-region-mini"></div>
      <div class="ksb-edit-menu" id="ksb-edit-menu" hidden></div>
    `;

    // 底部（迷你）区域整面可点切换模式，含模块间隙；编辑模式与待授权时让位
    widget.querySelector('.ksb-region-mini').addEventListener('click', (event) => {
      event.stopPropagation();
      if (editing || quotaAuthRequired) return;
      toggleMini();
      // 缩放仍随机播放轻动作，但使用独立安全池，排除会让球从无到有蹦出的 in。
      if (widgetConfig.orderMini.includes('pet')) petHandleToggle();
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

  function ensureWidget() {
    if (document.getElementById('ksb-widget')) {
      // SPA 可能重建 sidebar，导致缓存的引用失效
      if (!els || !els.widget.isConnected) cacheElements();
      if (els?.widget) sparkResizeObserver.observe(els.widget);
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

  function setConnectionHint(text) {
    if (els?.widget) els.widget.title = text || '';
  }

  /* ---------- 交互：手动刷新 / Mini 模式 ---------- */

  function manualRefresh() {
    setConnectionHint('正在刷新…');
    // 手动刷新绕过 background 的 30s 缓存，强制重拉 5h/本周/本月额度
    fetchQuota(true);
    if (cliUsageConnected) {
      chrome.runtime.sendMessage({ type: 'cli.usage.refresh' }).catch(() => {});
    }
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
      ? `<div class="ksb-menu-label">匀速参照线</div>${menuOpts('pace', [[true, '显示'], [false, '隐藏']], mod.pace)}`
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
    const hidden = widgetConfig.modules.external?.hiddenAccounts || [];
    if (!externalProviders.length) {
      return '<div class="ksb-menu-opts"><span class="ksb-menu-opt">暂无已配置账户</span></div>';
    }
    const opts = externalProviders
      .map((account) => {
        const visible = !hidden.includes(account.id);
        const label = `${account.name} ·${account.keyTail || ''}`;
        return `<span class="ksb-menu-opt ${visible ? 'ksb-on' : ''}" data-kind="accountToggle" data-value="${account.id}">${label}</span>`;
      })
      .join('');
    return `<div class="ksb-menu-opts">${opts}</div>`;
  }

  // 子代理模块的显隐开关：每个本会话出现过的代理一项（附模型名区分），点亮为显示，可连续切换
  function agentVisibilityOpts() {
    const hidden = widgetConfig.modules.agents?.hiddenAgents || [];
    const opts = sessionAgentOrder
      .map((agentId) => {
        const visible = !hidden.includes(agentId);
        const model = agentModelLabel(agentId);
        const label = `${agentDisplayName(agentId)}${model ? ` · ${model}` : ''}`;
        return `<span class="ksb-menu-opt ${visible ? 'ksb-on' : ''}" data-kind="agentToggle" data-value="${agentId}">${label}</span>`;
      })
      .join('');
    return `<div class="ksb-menu-opts">${opts}</div>`;
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
    const clamped = Math.max(0, Math.min(100, percentage));
    // 额度 API 的 limit 恒为 100、used 是整数百分比（实测响应），
    // 没有更细的精度，整数显示即可（一位小数只会恒为 .0）
    const displayPercentage = formatPercentage(clamped, 0);
    lastQuotaPct[prefix] = clamped;
    const target = els?.quota[prefix];
    if (!target) return;
    const color = progressClass(clamped);
    if (target.fill) {
      target.fill.style.width = `${clamped}%`;
      target.fill.className = `ksb-progress-fill ${color}`;
    }
    if (target.pct) {
      target.pct.textContent = `${displayPercentage}%`;
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
      ? `${formatPercentage(percentage)}%`
      : '--';
  }

  function updatePerfDisplay() {
    if (!els) return;
    if (els.speedVal) {
      const speed = currentSpeed();
      els.speedVal.textContent = speed > 0 ? `${speed} tok/s` : '--';
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

  // 状态最短显示时长：任何状态至少停留 1.5 秒，避免思考/回复/调用高速
  // 交替时文字一闪而过。挂起期间来的新状态覆盖待生效槽，到点播最新的一个。
  let displayedAgentStatus = '';
  let statusMinUntil = 0;
  let pendingDisplayStatus = null;
  let pendingStatusTimer = null;

  function paintAgentStatus(display) {
    if (!els) return;
    if (els.statusDot) els.statusDot.className = `ksb-status-dot ksb-${display}`;
    if (els.agentStatus) els.agentStatus.textContent = STATUS_TEXT[display] || display;
    petUpdateStatus(display);
  }

  function setAgentStatus(status) {
    metrics.agentStatus = status;
    if (!els) return;
    // 未授权时状态灯恒红（除非 WS 已断开，优先显示未连接）
    const display = quotaAuthRequired && status !== 'offline' ? 'unauthorized' : status;
    // 同状态重绘（如 DOM 重建后）不受最短时长限制
    if (display === displayedAgentStatus) {
      paintAgentStatus(display);
      return;
    }
    const wait = statusMinUntil - Date.now();
    if (wait <= 0) {
      displayedAgentStatus = display;
      statusMinUntil = Date.now() + STATUS_MIN_DISPLAY_MS;
      paintAgentStatus(display);
      return;
    }
    pendingDisplayStatus = display;
    if (!pendingStatusTimer) {
      pendingStatusTimer = setTimeout(() => {
        pendingStatusTimer = null;
        const next = pendingDisplayStatus;
        pendingDisplayStatus = null;
        if (next == null || next === displayedAgentStatus) return;
        displayedAgentStatus = next;
        statusMinUntil = Date.now() + STATUS_MIN_DISPLAY_MS;
        paintAgentStatus(next);
      }, wait);
    }
  }

  function renderAll() {
    updateTokenDisplay();
    updateCacheDisplay();
    updatePerfDisplay();
    setAgentStatus(metrics.agentStatus);
    renderSparks();
    renderAgents();
    renderExternal();
    renderPetStats();
  }

  /* ---------- 会话折线（整宽统计模块） ---------- */

  const SPARK_DEFS = {
    input: { values: () => sessionSamples.map((s) => s.input), fmt: (v) => formatTokenCount(v), marks: () => sessionSamples.map((s) => s.turnEnd === true) },
    output: { values: () => sessionSamples.map((s) => s.output), fmt: (v) => formatTokenCount(v), marks: () => sessionSamples.map((s) => s.turnEnd === true) },
    cache: { values: () => sessionSamples.map((s) => s.cachePct), fmt: (v) => `${formatPercentage(v)}%`, marks: () => sessionSamples.map((s) => s.turnEnd === true) },
    speed: { values: () => sessionSamples.map((s) => s.speed), fmt: (v) => `${v} tok/s`, marks: () => sessionSamples.map((s) => s.turnEnd === true) },
    duration: { values: () => turnDurations, fmt: (v) => fmtDuration(v) }
  };

  function renderSparks() {
    if (!els?.sparks) return;
    for (const [id, def] of Object.entries(SPARK_DEFS)) {
      renderSpark(els.sparks[id], def.values(), def.fmt, def.marks?.());
    }
  }

  // 侧栏拖拽改变面板宽度后，圆点反缩放参数（渲染时按当时宽度计算）会过期；
  // 监听面板尺寸变化重绘折线，任何宽度下圆点保持正圆
  let sparkResizeRaf = 0;
  const sparkResizeObserver = new ResizeObserver(() => {
    if (sparkResizeRaf) return;
    sparkResizeRaf = requestAnimationFrame(() => {
      sparkResizeRaf = 0;
      renderSparks();
    });
  });

  // 100×28 viewBox 的迷你折线：面积淡填充（两端渐隐）+ 折线 + 末点；基线恒含 0。
  // preserveAspectRatio="none" 横向拉伸 viewBox，直接画圆会变成扁椭圆；
  // 所有圆点用 transform 反缩放，r 按屏幕像素给，任何宽度下都是正圆。
  function renderSpark(svg, values, fmt, marks) {
    if (!svg) return;
    const pairs = values
      .map((v, i) => ({ v, turn: marks?.[i] === true }))
      .filter((p) => Number.isFinite(p.v));
    if (!pairs.length) {
      svg.replaceChildren();
      return;
    }
    const pts = pairs.map((p) => p.v);
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
    const rect = svg.getBoundingClientRect();
    const kx = rect.width > 0 ? rect.width / W : 1;
    const ky = rect.height > 0 ? rect.height / H : 1;
    const dot = (x, y, r, cls) =>
      `<circle class="${cls}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${(1 / kx).toFixed(4)} ${(1 / ky).toFixed(4)})" r="${r}"/>`;
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
        const label = pairs[i].turn ? `第${i + 1}步 · 本轮结束` : `第${i + 1}步`;
        return `<g class="ksb-spark-pt"><line class="ksb-spark-pt-line" x1="${fx}" y1="1" x2="${fx}" y2="27" stroke="url(#${svg.id}-linefade)"/>${dot(x, y, 2.6, 'ksb-spark-pt-dot')}<rect class="ksb-spark-hit" x="${rx.toFixed(1)}" y="0" width="${rw.toFixed(1)}" height="28" fill="transparent"><title>${label} · ${fmt(pts[i])}</title></rect></g>`;
      })
      .join('');
    // 整轮对话结束的步加常驻大节点，与最新点同款；最后一个点常与轮末重叠，画两次无视觉差异
    const turnDots = coords
      .map(([x, y], i) => (pairs[i].turn ? dot(x, y, 2.2, 'ksb-spark-dot') : ''))
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
        <linearGradient id="${svg.id}-xfade" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#ffffff" stop-opacity="0"/>
          <stop offset="0.06" stop-color="#ffffff" stop-opacity="1"/>
          <stop offset="0.94" stop-color="#ffffff" stop-opacity="1"/>
          <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
        </linearGradient>
        <mask id="${svg.id}-xmask">
          <rect x="0" y="0" width="100" height="28" fill="url(#${svg.id}-xfade)"/>
        </mask>
      </defs>
      <g mask="url(#${svg.id}-xmask)">
        <polygon class="ksb-spark-area" points="${areaPoints}" fill="url(#${svg.id}-vfade)"/>
        <polyline class="ksb-spark-line" points="${linePoints}"/>
      </g>
      ${turnDots}
      ${dot(lastX, lastY, 2.2, 'ksb-spark-dot')}
      ${hits}`;
  }

  /* ---------- 消耗量图表模块 ---------- */

  async function loadUsageDaily({ refreshIfStale = false } = {}) {
    try {
      const status = await chrome.runtime.sendMessage({ type: 'cli.usage.status' });
      cliUsageConnected = status?.ok === true && status.connected === true;
      const stored = await chrome.storage.local.get([
        KimiCliUsage.DAILY_STORAGE_KEY,
        KimiCliUsage.SECONDARY_MODEL_STORAGE_KEY
      ]);
      secondaryModelName = stored[KimiCliUsage.SECONDARY_MODEL_STORAGE_KEY] || '';
      usageDailyCache = cliUsageConnected
        ? stored[KimiCliUsage.DAILY_STORAGE_KEY] || {}
        : {};
      renderChart();
      renderAgents();
      renderPetStats();
      const lastScannedAt = Date.parse(status?.lastScannedAt || '');
      if (
        refreshIfStale &&
        cliUsageConnected &&
        !status.scanning &&
        (!Number.isFinite(lastScannedAt) || Date.now() - lastScannedAt >= CLI_REFRESH_STALE_MS)
      ) {
        chrome.runtime.sendMessage({ type: 'cli.usage.refresh' }).catch(() => {});
      }
    } catch (error) {
      cliUsageConnected = false;
      renderChart();
      renderPetStats();
    }
  }

  function scheduleCliUsageRefresh() {
    if (!cliUsageConnected) return;
    if (cliRefreshTimer) clearTimeout(cliRefreshTimer);
    // turn.ended 可能早于 wire 异步落盘；稍后只触发一次低频增量校准。
    cliRefreshTimer = setTimeout(() => {
      cliRefreshTimer = null;
      chrome.runtime.sendMessage({ type: 'cli.usage.refresh' }).catch(() => {});
    }, CLI_REFRESH_AFTER_TURN_MS);
  }

  function renderChart() {
    if (!els?.chartBars || !els.chartTotal) return;
    const module = els.chartBars.closest('.ksb-module');
    module?.classList.toggle('ksb-cli-required', !cliUsageConnected);
    if (els.cliLock) els.cliLock.hidden = cliUsageConnected;
    if (!cliUsageConnected) {
      els.chartTotal.textContent = '需连接';
      if (els.chartHitFull) els.chartHitFull.textContent = '';
      if (els.chartHitShort) els.chartHitShort.textContent = '';
      els.chartBars.replaceChildren();
      return;
    }
    const range = widgetConfig.modules.usageChart?.chartRange || 'week';
    const days = CHART_RANGE_DAYS[range] || 7;
    const endKey = usageDayKey(new Date());
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - (days - 1));
    const startKey = usageDayKey(startDate);
    const sum = sumUsageBetween(usageDailyCache, startKey, endKey);
    if (els.chartLabel) els.chartLabel.textContent = CHART_RANGE_LABELS[range] || CHART_RANGE_LABELS.week;
    els.chartTotal.textContent = sum.totalTokens > 0 ? formatTokenCount(sum.totalTokens) : '--';
    const hitPct = sum.cacheHitRate != null ? `${formatPercentage(sum.cacheHitRate * 100)}%` : '';
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

  // 子代理总览模块：主代理一行置顶；子代理按模型分组（同模型合并为一行，
  // 多实例标注 ×N）。徽标常态灰色，对应代理工作时点亮（主淡蓝、子淡绿）
  function renderAgents() {
    if (!els?.agentsList) return;
    const hiddenAgents = widgetConfig.modules.agents?.hiddenAgents || [];
    const mainWorking = petTurnActive || PET_ANSWER_STATUSES.includes(metrics.agentStatus);

    // 子代理按模型名分组汇总
    const groups = new Map();
    for (const agentId of sessionAgentOrder) {
      if (agentId === 'main' || hiddenAgents.includes(agentId)) continue;
      const totals = agentTotals[agentId];
      if (!totals) continue;
      const key = agentModelLabel(agentId);
      let group = groups.get(key);
      if (!group) {
        group = { ...emptyAgentMetric(), working: false, count: 0 };
        groups.set(key, group);
      }
      group.inputTokens += totals.inputTokens;
      group.outputTokens += totals.outputTokens;
      group.cacheReadTokens += totals.cacheReadTokens;
      group.cacheCreationTokens += totals.cacheCreationTokens;
      group.working = group.working || activeSubagents.has(agentId);
      group.count += 1;
    }

    const rows = [];
    const pushRow = ({ isMain, totals, working, name, title }) => {
      const hasUsage = totalInputTokens(totals) > 0 || totals.outputTokens > 0;
      // 无用量的子代理组只在「工作中」时占位；主代理始终显示
      if (!hasUsage && !working && !isMain) return;
      const hit = cacheReadPercentage(totals);
      const badge = isMain
        ? `<span class="ksb-agent-badge main${working ? ' on' : ''}">主</span>`
        : `<span class="ksb-agent-badge sub${working ? ' on' : ''}">子</span>`;
      rows.push(`
        <div class="ksb-agent-row${isMain ? ' main' : ''}" title="${title}">
          <span class="ksb-agent-id">${badge}</span>
          <span class="ksb-agent-model">${name}</span>
          <span class="ksb-agent-metric m-in">${formatTokenCount(totalInputTokens(totals))}</span>
          <span class="ksb-agent-metric m-out">${formatTokenCount(totals.outputTokens)}</span>
          <span class="ksb-agent-metric m-hit">${hit != null ? `${formatPercentage(hit)}%` : '--'}</span>
        </div>`);
    };

    const mainModel = agentModelLabel('main');
    pushRow({
      isMain: true,
      totals: agentTotals.main || emptyAgentMetric(),
      working: mainWorking,
      name: mainModel,
      title: `主代理${mainModel ? ` · ${mainModel}` : ''}`
    });
    for (const [model, group] of groups) {
      pushRow({
        isMain: false,
        totals: group,
        working: group.working,
        name: `${model}${group.count > 1 ? ` ×${group.count}` : ''}`,
        title: `子代理${model ? ` · ${model}` : ''}${group.count > 1 ? ` ×${group.count}` : ''}`
      });
    }
    els.agentsList.innerHTML = rows.join('');
  }

  /* ---------- 外部账户模块（DeepSeek / Kimi API / 智谱 / MiniMax） ---------- */

  let externalProviders = [];

  // 格式化单个账户的主数值与子数值：余额类「API 余额 ¥4.46」；
  // 套餐类「5h 40.0% · 1w 12.0%」；半宽只取主数值 + 次要窗口做下角标
  function formatExternalValue(provider) {
    if (provider.error) return { main: '获取失败', sub: '', note: provider.error };
    if (provider.kind === 'balance') {
      const main = `${provider.currency}${provider.total.toFixed(2)}`;
      return {
        main,
        sub: '',
        note: `赠送 ${provider.currency}${provider.granted.toFixed(2)} · 充值 ${provider.currency}${provider.paid.toFixed(2)}`
      };
    }
    if (provider.windows?.length) {
      const [first, second] = provider.windows;
      const reset = provider.windows.find((w) => w.resetAt)?.resetAt;
      return {
        main: `${formatPercentage(first.pct)}%`,
        sub: second ? `${second.label} ${formatPercentage(second.pct)}%` : '',
        note: [provider.plan, reset ? `重置 ${new Date(reset).toLocaleString()}` : '']
          .filter(Boolean)
          .join(' · ')
      };
    }
    return { main: provider.plan || '已启用', sub: '', note: '' };
  }

  function renderExternal() {
    const hiddenAccounts = widgetConfig.modules.external?.hiddenAccounts || [];
    const visible = externalProviders.filter((p) => !hiddenAccounts.includes(p.id));

    // 半宽：标题换成第一个选中账户的名称，大数字是它的余额/用量百分比
    if (els?.externalTitle) {
      const first = visible[0];
      els.externalTitle.textContent = first ? first.name : '外部账户';
      if (!first) {
        els.externalValue.textContent = '--';
        els.externalSub.hidden = true;
      } else {
        const formatted = formatExternalValue(first);
        els.externalValue.textContent = formatted.main;
        els.externalSub.textContent = formatted.sub;
        els.externalSub.hidden = !formatted.sub;
      }
    }

    // 整宽：一行一个账户，名称在左、格式化数值在右。
    // 数值的类型前缀（API 余额 / 5小时 等）单独成 span，窄面板时整体隐藏只留数字
    if (!els?.externalList) return;
    if (!visible.length) {
      els.externalList.innerHTML =
        '<div class="ksb-external-empty">在扩展弹窗中配置 API Key</div>';
      return;
    }
    // 同一 provider 多个账户时，用 key 尾号区分
    const nameCounts = {};
    for (const p of visible) nameCounts[p.name] = (nameCounts[p.name] || 0) + 1;
    const valueHtml = (provider) => {
      if (provider.error) return '获取失败';
      if (provider.kind === 'balance') {
        return `<span class="ksb-external-kind">API 余额</span> ${provider.currency}${provider.total.toFixed(2)}`;
      }
      if (provider.windows?.length) {
        return provider.windows
          .map((w) => `<span class="ksb-external-kind">${w.label}</span> ${formatPercentage(w.pct)}%`)
          .join(' · ');
      }
      return provider.plan || '已启用';
    };
    els.externalList.innerHTML = visible
      .map((provider) => {
        const label = nameCounts[provider.name] > 1
          ? `${provider.name} ·${provider.keyTail}`
          : provider.name;
        const formatted = formatExternalValue(provider);
        return `
          <div class="ksb-external-row" title="${label}${formatted.note ? ` · ${formatted.note}` : ''}">
            <span class="ksb-external-name">${label}</span>
            <span class="ksb-external-value${provider.error ? ' err' : ''}">${valueHtml(provider)}</span>
          </div>`;
      })
      .join('');
  }

  async function fetchExternalProviders() {
    if (widgetConfig.modules.external?.show === 'hidden') return;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'external.status' });
      if (response?.ok) {
        externalProviders = response.providers || [];
        renderExternal();
      }
    } catch (error) {
      // 扩展重载等场景下静默失败，保留现有显示
    }
  }

  // 宠物模块右侧数据：五种口径可选（≡ 菜单切换），标签与数值联动
  const PET_STAT_DEFS = {
    daily: {
      label: '24h消耗',
      value: () => {
        if (!cliUsageConnected) return '需连接 CLI';
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
        return pct != null ? `${formatPercentage(pct)}%` : '--';
      }
    },
    speed: {
      label: '速度',
      value: () => {
        const speed = currentSpeed();
        return speed > 0 ? `${speed} tok/s` : '--';
      }
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
  // 沿用 2.0.0 的命名动画方式：动作直接播放，颜色独立由 CSS 表达。
  const PET_RIV_URL = chrome.runtime.getURL('rive/kimi_avatar_web-PnsTWI-X.riv');
  const PET_WASM_URL = chrome.runtime.getURL('rive/rive.wasm');
  const PET_IDLE_ANIM = 'paopao';
  const PET_LOADING_ANIM = 'loading';
  const PET_DONE_ANIM = 'stars';
  // stars 只负责让星星出现，粒子退场由 nostars 负责（v2.0 的 stars→nostars 链）
  const PET_DONE_OUTRO_ANIM = 'nostars';
  const PET_CLICK_ANIMS = [
    'yaoyiyao', 'angryface', 'wink', 'angryeye',
    'hover', 'hover100', 'wink_stop', 'paopao_stop'
  ];
  const PET_TOGGLE_ANIMS = [
    'yaoyiyao', 'angryface', 'wink', 'angryeye', 'hover', 'hover100'
  ];
  // 不重新引入颜色/状态混合的官网状态机，只恢复它的低频空闲变化。
  const PET_IDLE_AMBIENT_ANIMS = ['wink', 'look_right_stop'];
  const PET_IDLE_AMBIENT_MIN_MS = 8_000;
  const PET_IDLE_AMBIENT_JITTER_MS = 10_000;

  let petRive = null;
  let petCanvasEl = null;
  // 记录点球监听器绑在哪个 canvas 上，结构重建时避免重复绑定
  let petClickBoundCanvas = null;
  let petStatus = 'idle';
  let petMotion = '';
  let petStarsVisible = false;
  let petSwitchingMotion = false;
  let petReturnToBase = false;
  let petIdleAmbientTimer = null;
  let petTurnSessionId = '';
  let petTurnActive = false;
  let petTurnSince = 0;
  // 状态时钟：进入当前状态的时间点与 1s 计时器
  let petStatusSince = Date.now();
  let restoredPetStatusSince = 0;
  let petClockTimer = null;

  const PET_CLOCK_STATUSES = ['thinking', 'executing', 'replying', 'subagent', 'ratelimit'];
  // 一轮回答的组成状态：这些状态之间切换（思考↔执行↔运行↔子代理↔限流）不打断计时
  const PET_ANSWER_STATUSES = ['thinking', 'executing', 'replying', 'subagent', 'ratelimit'];

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

  function petAppearanceForStatus(status) {
    if (status === 'offline' || status === 'unauthorized') return 'gray';
    if (status === 'ratelimit') return 'red';
    return 'blue';
  }

  function petApplyAppearance() {
    if (!els?.petCanvas) return;
    els.petCanvas.dataset.appearance = petAppearanceForStatus(petStatus);
  }

  function petClearIdleAmbient() {
    if (petIdleAmbientTimer) clearTimeout(petIdleAmbientTimer);
    petIdleAmbientTimer = null;
  }

  function petScheduleIdleAmbient() {
    petClearIdleAmbient();
    if (petStatus !== 'idle' || !petRive) return;
    const delay = PET_IDLE_AMBIENT_MIN_MS + Math.random() * PET_IDLE_AMBIENT_JITTER_MS;
    petIdleAmbientTimer = setTimeout(() => {
      petIdleAmbientTimer = null;
      if (petStatus !== 'idle' || petMotion !== PET_IDLE_ANIM || !petRive) {
        petScheduleIdleAmbient();
        return;
      }
      const name = PET_IDLE_AMBIENT_ANIMS[
        Math.floor(Math.random() * PET_IDLE_AMBIENT_ANIMS.length)
      ];
      petPlayMotion(name, { returnToBase: true });
    }, delay);
  }

  function petPlayMotion(name, { returnToBase = false } = {}) {
    if (!petRive) return;
    petClearIdleAmbient();
    try {
      petSwitchingMotion = true;
      petReturnToBase = returnToBase;
      petRive.stop();
      petRive.play(name);
      petMotion = name;
      if (name === PET_IDLE_ANIM) petScheduleIdleAmbient();
    } catch (error) {
      console.warn('[Kimi Status] 吉祥物动画切换失败', error);
    } finally {
      petSwitchingMotion = false;
    }
  }

  function petBaseMotion() {
    return PET_ANSWER_STATUSES.includes(petStatus) ? PET_LOADING_ANIM : PET_IDLE_ANIM;
  }

  function petPlayBase() {
    // 星星粒子还挂着：先播 nostars 让它们退场，再回到基底。
    // 覆盖 stars 自然结束与 stars 被打断两条路径（被打断时粒子停留中途帧）
    if (petStarsVisible && petMotion !== PET_DONE_OUTRO_ANIM) {
      petPlayMotion(PET_DONE_OUTRO_ANIM, { returnToBase: true });
      return;
    }
    const desired = petBaseMotion();
    if (petMotion === desired && petRive?.playingAnimationNames?.includes(desired)) return;
    petPlayMotion(desired);
  }

  function petSyncState() {
    petApplyAppearance();
    petPlayBase();
  }

  function petBeginTurn() {
    petTurnSessionId = sessionId;
    petTurnActive = Boolean(sessionId);
    petTurnSince = Date.now();
  }

  function petCancelTurn() {
    petTurnSessionId = '';
    petTurnActive = false;
    petTurnSince = 0;
  }

  function petCompleteTurn() {
    // 重放的历史事件里 turn.started 与 turn.ended 间隔只有几毫秒；
    // 真实一轮回答至少持续一秒以上，据此抑制重放触发的 Stars
    const shouldCelebrate =
      petTurnActive &&
      petTurnSessionId === sessionId &&
      Date.now() - petTurnSince > 1_000;
    petCancelTurn();
    if (shouldCelebrate) petPlayDoneEffect();
  }

  function petHandleClick() {
    const name = PET_CLICK_ANIMS[Math.floor(Math.random() * PET_CLICK_ANIMS.length)];
    petPlayMotion(name, { returnToBase: true });
  }

  function petHandleToggle() {
    const name = PET_TOGGLE_ANIMS[Math.floor(Math.random() * PET_TOGGLE_ANIMS.length)];
    petPlayMotion(name, { returnToBase: true });
  }

  // Stars 只由真实 turn 生命周期触发，播放完回到当前基底动画。
  function petPlayDoneEffect() {
    if (!petRive || petMotion === PET_DONE_ANIM) return;
    petStarsVisible = true;
    petPlayMotion(PET_DONE_ANIM, { returnToBase: true });
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
      petMotion = '';
      petStarsVisible = false;
      petSwitchingMotion = false;
      petReturnToBase = false;
      petClearIdleAmbient();
    }
    if (!els?.petCanvas) return;
    // wasm 强制走本地，禁用 CDN 回退（扩展不允许远程代码）
    api.RuntimeLoader.setWasmUrl(PET_WASM_URL);
    api.RuntimeLoader.setWasmFallbackUrl(null);
    const instance = new api.Rive({
      src: PET_RIV_URL,
      canvas: els.petCanvas,
      autoplay: false,
      fit: api.Fit?.Contain,
      alignment: api.Alignment?.Center,
      onLoad: () => {
        if (petRive !== instance) return;
        petSyncState();
      },
      onStop: (event) => {
        // stop()+play() 的主动切换不处理；只有 one-shot 自然结束才续播。
        if (petRive !== instance || petSwitchingMotion) return;
        const stopped = Array.isArray(event?.data) ? event.data : [];
        if (!stopped.includes(petMotion)) return;
        queueMicrotask(() => {
          if (petRive !== instance || petSwitchingMotion) return;
          if (petMotion === PET_LOADING_ANIM && PET_ANSWER_STATUSES.includes(petStatus)) {
            petPlayMotion(PET_LOADING_ANIM);
            return;
          }
          // nostars 自然播完才认定粒子已退场（中途被打断则保留标记，下次回基底时补播）
          if (petMotion === PET_DONE_OUTRO_ANIM) petStarsVisible = false;
          if (petReturnToBase) {
            petReturnToBase = false;
            petPlayBase();
          }
        });
      },
      onLoadError: (error) => console.warn('[Kimi Status] 吉祥物动画加载失败', error)
    });
    petRive = instance;
    petCanvasEl = els.petCanvas;
    petApplyAppearance();
    petSyncRendering();
    petClockStart();
    // 点球：播放一次命名动作；配置了跳转则同时打开（控制台/充值页，≡ 菜单可选）。
    // 同一 canvas 只绑一次，避免结构复用时重复触发。
    if (petClickBoundCanvas !== els.petCanvas) {
      els.petCanvas.addEventListener('click', (event) => {
        event.stopPropagation();
        petHandleClick();
        const link = widgetConfig.modules.pet?.ballLink;
        if (link === 'console' || link === 'subscription') {
          window.open(link === 'console' ? CONSOLE_URL : SUBSCRIPTION_URL, '_blank');
        }
      });
      petClickBoundCanvas = els.petCanvas;
    }
  }

  // 与状态灯同源：命名动画只负责动作，CSS 只负责蓝/灰/红外观。
  // Stars 由同一会话的 turn 生命周期触发，不再从显示状态变化推断。
  function petUpdateStatus(display) {
    if (els?.petStatusText) {
      const lines = STATUS_TEXT_LINES[display];
      if (lines) {
        // 长状态按语义切两行（如「子代理/工作中」），下边缘与单行状态对齐
        els.petStatusText.replaceChildren(lines[0], document.createElement('br'), lines[1]);
        els.petStatusText.classList.add('ksb-status-twoline');
      } else {
        els.petStatusText.textContent = STATUS_TEXT[display] || display;
        els.petStatusText.classList.remove('ksb-status-twoline');
      }
      els.petStatus.dataset.status = display;
    }
    if (display === petStatus) {
      // 重复状态只刷新颜色，不能打断正在播放的 Stars / 点击动作；
      // loading 自然结束后的续播由唯一的 onStop 分支负责。
      petApplyAppearance();
      return;
    }
    const previous = petStatus;
    petStatus = display;
    // 计时不被工具调用打断：仅在「非回答状态 → 回答状态」或进入非回答状态时重置起点；
    // 思考↔回复↔调用↔子代理↔限流之间切换属于同一轮回答，连续计时
    if (PET_ANSWER_STATUSES.includes(display) && !PET_ANSWER_STATUSES.includes(previous)) {
      petStatusSince = Date.now();
    } else if (!PET_ANSWER_STATUSES.includes(display)) {
      petStatusSince = Date.now();
    }
    petClockTick();
    petSyncState();
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
    const petBalanceVisible =
      modules.pet?.show !== 'hidden' && modules.pet?.stat === 'balance';
    return quotaVisible || balanceVisible || petBalanceVisible;
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
      if (required && els.authBannerText) els.authBannerText.textContent = '点击完成 Kimi 授权';
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
      if (els.authBannerText) {
        els.authBannerText.textContent = '授权中，完成后自动恢复';
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
    metrics.lastDuration = 0;
    metrics.agentStatus = 'idle';
    // 游标不在这里重置：startSession 已统一归零，
    // 空壳快照/快照失败只是数据不可用，不能据此把游标打回 0 触发全量重放
    sessionSamples = [];
    turnDurations = [];
    agentTotals = { main: emptyAgentMetric() };
    sessionAgentOrder = ['main'];
    agentTopModels = {};
    renderAll();
  }

  function clearSessionHistory() {
    metrics.lastDuration = 0;
    sessionSamples = [];
    turnDurations = [];
    agentTotals = { main: emptyAgentMetric() };
    sessionAgentOrder = ['main'];
    agentTopModels = {};
  }

  // 空壳快照（忙碌会话）或拉取失败时的本地恢复：CLI 扫描的按会话汇总做底，
  // 之后的实时 WS 事件在其上累计——底数只含扫描时刻之前的记录，不双算。
  function applySessionSeed(seed) {
    metrics.inputTokens = Math.max(
      0,
      toNonNegativeInteger(seed.input) - toNonNegativeInteger(seed.cacheRead)
    );
    metrics.outputTokens = toNonNegativeInteger(seed.output);
    metrics.cacheReadTokens = toNonNegativeInteger(seed.cacheRead);
    metrics.cacheCreationTokens = 0;

    // 按代理拆分：主代理置顶，子代理按最早记录时间排序；模型取 token 权重最高者
    agentTotals = {};
    sessionAgentOrder = [];
    agentTopModels = {};
    const agents = seed.agents && typeof seed.agents === 'object' ? seed.agents : {};
    const names = Object.keys(agents).sort((a, b) => {
      if (a === 'main') return -1;
      if (b === 'main') return 1;
      return (agents[a].firstAt || 0) - (agents[b].firstAt || 0);
    });
    for (const name of names.length ? names : ['main']) {
      const entry = agents[name];
      agentTotals[name] = {
        inputTokens: Math.max(
          0,
          toNonNegativeInteger(entry?.input) - toNonNegativeInteger(entry?.cacheRead)
        ),
        outputTokens: toNonNegativeInteger(entry?.output),
        cacheReadTokens: toNonNegativeInteger(entry?.cacheRead),
        cacheCreationTokens: 0
      };
      sessionAgentOrder.push(name);
      // config.update 的 modelAlias 是解析后的真实模型名（子代理的 usage 记录只有占位符）
      const alias = typeof entry?.modelAlias === 'string' ? entry.modelAlias : '';
      const models = entry?.models && typeof entry.models === 'object' ? entry.models : {};
      const top = Object.entries(models).sort((x, y) => y[1] - x[1])[0];
      if (alias || top) agentTopModels[name] = alias || top[0];
    }
  }

  async function readSessionSeed(targetSessionId) {
    const stored = await chrome.storage.local.get(KimiCliUsage.SESSIONS_STORAGE_KEY);
    return stored[KimiCliUsage.SESSIONS_STORAGE_KEY]?.[targetSessionId] || null;
  }

  // 只补按代理拆分（不清空服务端已给的总量）：快照没有 agents 维度
  async function seedAgentsFromScan(targetSessionId) {
    try {
      const seed = await readSessionSeed(targetSessionId);
      if (!seed?.agents || targetSessionId !== sessionId) return;
      const keep = { ...metrics };
      applySessionSeed(seed);
      metrics.inputTokens = keep.inputTokens;
      metrics.outputTokens = keep.outputTokens;
      metrics.cacheReadTokens = keep.cacheReadTokens;
      metrics.cacheCreationTokens = keep.cacheCreationTokens;
      renderAll();
    } catch (error) {
      // 读取失败不影响主显示
    }
  }

  async function restoreSessionFromScan(targetSessionId, stale) {
    try {
      const seed = await readSessionSeed(targetSessionId);
      if (stale()) return;
      if (seed) {
        applySessionSeed(seed);
        sessionSamples = [];
        turnDurations = [];
        renderAll();
      } else {
        resetMetrics();
      }
    } catch (error) {
      if (!stale()) resetMetrics();
    }
  }

  // 轮次结束后台重扫完成：本地按会话汇总已包含刚结束的轮次；空闲时用它刷新
  // 面板底数（实时累计已被汇总覆盖，直接替换不双算），忙碌时跳过等下一轮。
  async function refreshSessionSeedFromScan() {
    if (!sessionId || petTurnActive) return;
    if (PET_ANSWER_STATUSES.includes(metrics.agentStatus)) return;
    try {
      const seed = await readSessionSeed(sessionId);
      if (!seed) return;
      applySessionSeed(seed);
      renderAll();
    } catch (error) {
      // 读取失败不影响现有显示
    }
  }

  async function loadSessionSnapshot(targetSessionId, targetToken, requestId, sessionChanged, hasLocalState = false) {
    if (!targetSessionId || !targetToken) return;
    const stale = () =>
      requestId !== sessionRequestId || targetSessionId !== sessionId || targetToken !== token;
    try {
      const response = await fetch(`/api/v1/sessions/${encodeURIComponent(targetSessionId)}`, {
        headers: { Authorization: `Bearer ${targetToken}` },
        signal: AbortSignal.timeout(15_000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      // 新版接口返回 { code, data, msg }，旧版直接返回会话对象。
      const data = body?.data && typeof body.data === 'object' ? body.data : body;
      if (stale()) return;
      // 快照带 usage：以服务器累计为准
      const snapshotUsage = data?.usage ? normalizeUsage(data.usage) : null;
      // 服务端对忙碌中的会话返回全零 usage/last_seq 的空壳快照（实测），
      // 这种会话由本地按会话汇总恢复，服务器值不可信。
      const snapshotLooksUnavailable =
        snapshotUsage &&
        toNumber(data.last_seq) === 0 &&
        totalInputTokens(snapshotUsage) === 0 &&
        snapshotUsage.outputTokens === 0;
      if (snapshotUsage && !snapshotLooksUnavailable) {
        const usage = snapshotUsage;
        metrics.inputTokens = usage.inputTokens;
        metrics.outputTokens = usage.outputTokens;
        metrics.cacheReadTokens = usage.cacheReadTokens;
        metrics.cacheCreationTokens = usage.cacheCreationTokens;
        metrics.agentStatus = data.busy || data.main_turn_active ? 'thinking' : 'idle';
        // 游标只前进不回退：快照的 last_seq 可能早于已处理的实时事件
        const snapshotSeq = toNumber(data.last_seq);
        lastSeq = Math.max(lastSeq, snapshotSeq);
        lastUsageSeq = Math.max(lastUsageSeq, snapshotSeq);
        lastTurnSeq = Math.max(lastTurnSeq, snapshotSeq);
        // 有本地恢复（内存缓存/汇总）时样本与计时保持连续，不清空
        if (sessionChanged && !hasLocalState) {
          clearSessionHistory();
          // 服务端快照没有按代理拆分，用本地扫描的按代理汇总补齐子代理视图
          seedAgentsFromScan(targetSessionId);
        }
        renderAll();
        return;
      }
      metrics.agentStatus = data?.busy || data?.main_turn_active ? 'thinking' : 'idle';
      // 空壳快照：内存缓存已由 startSession 恢复时不动数据；否则用本地汇总做底
      if (sessionChanged && !hasLocalState) {
        await restoreSessionFromScan(targetSessionId, stale);
        return;
      }
      renderAll();
    } catch (error) {
      console.warn('[Kimi Status] 会话快照拉取失败，改由本地按会话汇总恢复', error);
      if (!stale() && sessionChanged) {
        if (hasLocalState) renderAll();
        else await restoreSessionFromScan(targetSessionId, stale);
      }
    }
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
      // 断线统一显示「未连接」，后台退避重连；重连成功后由 server_hello 恢复
      setAgentStatus('offline');
      setConnectionHint(`WebSocket 已断开（${event.code}${event.reason ? `: ${event.reason}` : ''}），正在重连…`);
      reconnectAttempts += 1;
      scheduleReconnect();
    };

    ws.onerror = () => setConnectionHint('WebSocket 连接失败');
  }

  function scheduleReconnect() {
    if (disposed || reconnectTimer) return;
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

  // 订阅重放闸门：服务器对游标落后的空闲会话会全量重放历史事件（实测），
  // 重放结束后才发 ack/resync_required。ack 之前到达的事件不改状态、不播 Stars；
  // 历史重放只进折线样本（真实历史，图表数据源），断线补发照常计数。
  let awaitingAck = false;
  let ackWatchdog = null;
  // 下次 client_hello 使用的游标：会话切换后固定为 0（换取历史重放来填充折线样本），
  // ack 之后更新为当前水位（断线重连时只补发未见事件）
  let subscriptionCursor = 0;
  let replayIsHistory = false;
  let replaySamplesExpected = false;

  function clearAckWatchdog() {
    if (ackWatchdog) clearTimeout(ackWatchdog);
    ackWatchdog = null;
  }

  function sendFrame(frame) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  }

  function sendClientHello() {
    awaitingAck = true;
    replayIsHistory = subscriptionCursor === 0;
    // 已有样本（内存缓存恢复 / 断线重连）时重放不再进样本，避免重复
    replaySamplesExpected = sessionSamples.length === 0;
    // 个别服务端可能不回 ack：超时强制放行，避免实时事件被永久抑制
    clearAckWatchdog();
    ackWatchdog = setTimeout(() => {
      ackWatchdog = null;
      awaitingAck = false;
    }, 3_000);
    sendFrame({
      type: 'client_hello',
      id: `ksb-${Date.now()}`,
      payload: {
        client_id: 'kimi-statusbar',
        subscriptions: [sessionId],
        cursors: { [sessionId]: { seq: subscriptionCursor } }
      }
    });
  }

  function setAgentWorkStatus(status) {
    deferredWorkStatus = status;
    if (activeToolCalls > 0 || Date.now() < toolStatusUntil) {
      setAgentStatus('executing');
      return;
    }
    setAgentStatus(status);
  }

  function clearToolStatus() {
    activeToolCalls = 0;
    toolStatusUntil = 0;
    deferredWorkStatus = 'thinking';
    if (toolStatusTimer) clearTimeout(toolStatusTimer);
    toolStatusTimer = null;
  }

  function beginToolStatus() {
    activeToolCalls += 1;
    toolStatusUntil = Math.max(toolStatusUntil, Date.now() + TOOL_STATUS_MIN_MS);
    if (toolStatusTimer) clearTimeout(toolStatusTimer);
    toolStatusTimer = null;
    setAgentStatus('executing');
  }

  function finishToolStatus() {
    activeToolCalls = Math.max(0, activeToolCalls - 1);
    // deferredWorkStatus 保留 setAgentWorkStatus 写入的最新工作状态，
    // 工具锁释放后直接用它恢复；默认值由 turn.started/turn.ended 的 clearToolStatus 重置
    if (activeToolCalls > 0) {
      setAgentStatus('executing');
      return;
    }
    const remaining = toolStatusUntil - Date.now();
    if (remaining <= 0) {
      toolStatusUntil = 0;
      setAgentStatus(deferredWorkStatus);
      return;
    }
    if (toolStatusTimer) clearTimeout(toolStatusTimer);
    toolStatusTimer = setTimeout(() => {
      toolStatusTimer = null;
      toolStatusUntil = 0;
      if (activeToolCalls === 0) setAgentStatus(deferredWorkStatus);
    }, remaining);
  }

  // 事件的子代理身份：step/delta 事件在 message 或 payload 上带 agent_id/agentId，
  // subagent.* 生命周期事件带 payload.subagentId
  function isSubagentEvent(message, payload) {
    const id =
      message.agent_id ?? payload.agent_id ?? payload.agentId ?? payload.subagentId;
    return Boolean(id) && id !== 'main';
  }

  // 事件归属的代理 id：缺省视为主代理
  function eventAgentId(message, payload) {
    return (
      message.agent_id ?? payload.agent_id ?? payload.agentId ?? payload.subagentId ?? 'main'
    );
  }

  function handleWsMessage(message) {
    if (message.type === 'server_hello') {
      clearHelloWatchdog();
      reconnectAttempts = 0;
      setConnectionHint('Kimi Status 已连接');
      // 重连成功后先回到空闲，后续事件（含游标补发的）会把状态修正过来
      if (metrics.agentStatus === 'offline') {
        setAgentStatus('idle');
      }
      sendClientHello();
      return;
    }

    if (message.type === 'ping') {
      sendFrame({ type: 'pong', payload: { nonce: message.payload?.nonce } });
      return;
    }

    // 订阅应答：重放边界。ack / resync_required 之后到达的才是实时事件
    if (message.type === 'ack' || message.type === 'resync_required') {
      clearAckWatchdog();
      awaitingAck = false;
      subscriptionCursor = lastSeq;
      renderAll();
      return;
    }

    // 重放事件（ack 之前到达）：不改状态、不播 Stars。
    // 历史重放（订阅游标为 0）只进折线样本，面板计数已由快照/本地汇总恢复；
    // 断线补发（游标非 0）是页面加载后的新事件，汇总未含，照常计数。
    if (awaitingAck) {
      const replaySeq = Number(message.seq);
      if (Number.isFinite(replaySeq)) {
        lastSeq = Math.max(lastSeq, replaySeq);
        lastUsageSeq = Math.max(lastUsageSeq, replaySeq);
        lastTurnSeq = Math.max(lastTurnSeq, replaySeq);
      }
      const replayPayload = message.payload || {};
      if (message.type === 'turn.step.completed') {
        const replayAgent = eventAgentId(message, replayPayload);
        if (replayIsHistory) {
          // 历史重放：只进折线样本并登记代理顺序，不进任何计数器
          registerSessionAgent(replayAgent);
          if (replaySamplesExpected) pushStepSample(replayPayload);
        } else {
          handleStepCompleted(replayPayload, replayAgent);
        }
      } else if (message.type === 'turn.ended' || message.type === 'turn.completed') {
        pushReplayedTurnDuration(replayPayload);
        if (!replayIsHistory) scheduleCliUsageRefresh();
      }
      return;
    }

    if (message.session_id && message.session_id !== sessionId) return;
    // volatile 帧复用当前 durable watermark；相同 seq 不代表重复，不能被游标过滤。
    // 只有 durable 事件推进/校验 lastSeq，client_hello 的补发游标也只认 durable 序号。
    if (message.seq != null && message.volatile !== true) {
      const sequence = Number(message.seq);
      if (Number.isFinite(sequence)) {
        if (sequence <= lastSeq) return;
        lastSeq = sequence;
      }
    }
    const payload = message.payload || {};

    switch (message.type) {
      case 'turn.started':
        clearToolStatus();
        petBeginTurn();
        setAgentStatus('thinking');
        break;
      case 'turn.step.started':
        setAgentWorkStatus(isSubagentEvent(message, payload) ? 'subagent' : 'thinking');
        break;
      case 'turn.step.completed':
        // 快照失败后 cursor=0 会补发旧事件；当前页面已处理过的 step 只用于恢复状态，
        // 不再重复累加面板数值。真正缺失的新 step 仍会正常进入。
        if (!Number.isFinite(Number(message.seq)) || Number(message.seq) > lastUsageSeq) {
          handleStepCompleted(payload, eventAgentId(message, payload));
          if (Number.isFinite(Number(message.seq))) lastUsageSeq = Number(message.seq);
        }
        // step 之间的间隙通常在执行工具或等待模型，主代理统一显示「思考中」；
        // 子代理的 step 单独显示「子代理工作中」
        setAgentWorkStatus(isSubagentEvent(message, payload) ? 'subagent' : 'thinking');
        break;
      case 'thinking.delta':
        // 主代理的推理流；子代理的 delta 不改变「子代理工作中」显示
        if (!isSubagentEvent(message, payload) && deferredWorkStatus !== 'thinking') {
          setAgentWorkStatus('thinking');
        }
        break;
      case 'assistant.delta':
        // 主代理正在输出回复正文
        if (!isSubagentEvent(message, payload) && deferredWorkStatus !== 'replying') {
          setAgentWorkStatus('replying');
        }
        break;
      case 'subagent.spawned':
      case 'subagent.started':
      case 'subagent.suspended': {
        const subId = payload.subagentId ?? payload.agentId;
        if (subId) {
          registerSessionAgent(String(subId));
          activeSubagents.add(String(subId));
        }
        setAgentWorkStatus('subagent');
        break;
      }
      case 'subagent.completed':
      case 'subagent.failed': {
        const subId = payload.subagentId ?? payload.agentId;
        if (subId) activeSubagents.delete(String(subId));
        // 子代理结束后主代理通常继续本轮；后续事件会修正具体状态
        setAgentWorkStatus('thinking');
        break;
      }
      case 'tool.call.started':
        // 当前服务通常在 1–20ms 内连续发 started/result；保留最短可见时长供人眼识别。
        beginToolStatus();
        break;
      case 'tool.result':
        finishToolStatus();
        break;
      case 'turn.ended':
      case 'turn.completed': {
        const turnSequence = Number(message.seq);
        const alreadyRecorded = Number.isFinite(turnSequence) && turnSequence <= lastTurnSeq;
        const duration = toNumber(payload.durationMs ?? payload.duration_ms ?? payload.duration);
        if (!alreadyRecorded && duration > 0) {
          metrics.lastDuration = duration;
          turnDurations.push(duration);
          if (turnDurations.length > SESSION_SAMPLE_LIMIT) turnDurations.shift();
        }
        if (Number.isFinite(turnSequence)) lastTurnSeq = Math.max(lastTurnSeq, turnSequence);
        clearToolStatus();
        setAgentStatus('idle');
        if (!alreadyRecorded) {
          // 折线图：本轮最后一个 step 样本加常驻大节点，区分轮内调用与整轮结束
          const lastSample = sessionSamples[sessionSamples.length - 1];
          if (lastSample) lastSample.turnEnd = true;
          petCompleteTurn();
        }
        renderAll();
        scheduleCliUsageRefresh();
        break;
      }
      case 'event.session.work_changed': {
        const busy = Boolean(payload.busy || payload.main_turn_active);
        // 订阅初期推送的可能是滞留状态：页面未观察到轮次活动时只接受收工信号
        if (busy && !petTurnActive) break;
        setAgentWorkStatus(busy ? 'thinking' : 'idle');
        break;
      }
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
    // 订阅后服务端会补推该会话最后一次 agent 状态，可能是滞留的 working/thinking；
    // 开工状态只以快照 busy 标志与真实 turn 事件为准，这里在轮次活动外只接受收工
    if (status === 'idle' || status === 'waiting') {
      setAgentWorkStatus('idle');
      return;
    }
    if (!petTurnActive) return;
    if (status === 'thinking' || status === 'processing') setAgentWorkStatus('thinking');
    else if (status === 'running' || status === 'working') setAgentWorkStatus('thinking');
  }

  // 记录本步样本（折线图数据源，实时与重放共用）；速度/命中率无法计算时为 null，渲染跳过
  function pushStepSample(payload) {
    const usage = normalizeUsage(payload.usage || payload.token_usage);
    const streamDuration = payload.llmStreamDurationMs ?? payload.llmServerDecodeMs;
    const speed = decodeSpeed(usage.outputTokens, streamDuration);
    const stepInput = totalInputTokens(usage);
    sessionSamples.push({
      input: stepInput,
      output: usage.outputTokens,
      cachePct: stepInput > 0 ? (usage.cacheReadTokens / stepInput) * 100 : null,
      speed,
      outMs: Number.isFinite(Number(streamDuration)) ? Number(streamDuration) : null
    });
    if (sessionSamples.length > SESSION_SAMPLE_LIMIT) sessionSamples.shift();
  }

  // 面板速度大数字：最近若干步的聚合速度（总输出 ÷ 总流式时长），
  // 单步时长极短的离群样本（缓存秒回/高速模型）不会把显示值顶飞
  function currentSpeed() {
    return aggregateSpeed(sessionSamples);
  }

  // 重放的轮次结束：只记耗时样本与轮末标记，不播 Stars、不动状态
  function pushReplayedTurnDuration(payload) {
    const duration = toNumber(payload.durationMs ?? payload.duration_ms ?? payload.duration);
    if (duration > 0) {
      metrics.lastDuration = duration;
      turnDurations.push(duration);
      if (turnDurations.length > SESSION_SAMPLE_LIMIT) turnDurations.shift();
    }
    const lastSample = sessionSamples[sessionSamples.length - 1];
    if (lastSample) lastSample.turnEnd = true;
  }

  function handleStepCompleted(payload, agentId = 'main') {
    const usage = normalizeUsage(payload.usage || payload.token_usage);

    metrics.inputTokens += usage.inputTokens;
    metrics.outputTokens += usage.outputTokens;
    metrics.cacheReadTokens += usage.cacheReadTokens;
    metrics.cacheCreationTokens += usage.cacheCreationTokens;

    registerSessionAgent(agentId);
    const totals = agentTotals[agentId];
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.cacheReadTokens += usage.cacheReadTokens;
    totals.cacheCreationTokens += usage.cacheCreationTokens;

    pushStepSample(payload);
    renderAll();
  }

  // 同页切换会话的面板状态缓存：切走存档、切回瞬时恢复（数值、折线、计时连续）。
  // 只活在页面内存里；单会话约 2-3KB，上限 30 个会话，超出淘汰最久未访问的。
  const PANEL_SESSION_CACHE_LIMIT = 30;
  const panelSessionCache = new Map();

  function cachePanelState(sid) {
    if (!sid) return;
    if (panelSessionCache.has(sid)) panelSessionCache.delete(sid);
    panelSessionCache.set(sid, {
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
      cacheReadTokens: metrics.cacheReadTokens,
      cacheCreationTokens: metrics.cacheCreationTokens,
      lastDuration: metrics.lastDuration,
      agentStatus: metrics.agentStatus,
      petStatusSince,
      sessionSamples: sessionSamples.slice(),
      turnDurations: turnDurations.slice(),
      agentTotals: JSON.parse(JSON.stringify(agentTotals)),
      sessionAgentOrder: sessionAgentOrder.slice(),
      agentTopModels: { ...agentTopModels }
    });
    while (panelSessionCache.size > PANEL_SESSION_CACHE_LIMIT) {
      panelSessionCache.delete(panelSessionCache.keys().next().value);
    }
  }

  function restorePanelState(sid) {
    const cached = panelSessionCache.get(sid);
    if (!cached) return false;
    panelSessionCache.delete(sid);
    panelSessionCache.set(sid, cached); // 移到最新
    metrics.inputTokens = cached.inputTokens;
    metrics.outputTokens = cached.outputTokens;
    metrics.cacheReadTokens = cached.cacheReadTokens;
    metrics.cacheCreationTokens = cached.cacheCreationTokens;
    metrics.lastDuration = cached.lastDuration;
    metrics.agentStatus = cached.agentStatus;
    sessionSamples = cached.sessionSamples;
    turnDurations = cached.turnDurations;
    agentTotals = cached.agentTotals;
    sessionAgentOrder = cached.sessionAgentOrder;
    agentTopModels = cached.agentTopModels;
    // 计时起点在 setAgentStatus 之后由调用方恢复（状态切换会重置它）
    restoredPetStatusSince = cached.petStatusSince;
    return true;
  }

  function disconnectWebSocket() {
    clearHelloWatchdog();
    clearAckWatchdog();
    awaitingAck = false;
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
    sessionSnapshotPending = true;
    disconnectWebSocket();
    const sessionChanged = nextSessionId !== sessionId;
    if (sessionChanged) {
      cachePanelState(sessionId);
      petCancelTurn();
      clearToolStatus();
      activeSubagents.clear();
      // 上一会话挂起的状态节流不能带到新会话，立即放行下一个状态
      if (pendingStatusTimer) clearTimeout(pendingStatusTimer);
      pendingStatusTimer = null;
      pendingDisplayStatus = null;
      statusMinUntil = 0;
      // 换会话：游标固定归零。空闲会话的历史重放由 ack 闸门控制（只进折线样本），
      // 面板数据由「快照 + 本地按会话汇总」恢复，WS 只接实时事件。
      lastSeq = 0;
      lastUsageSeq = 0;
      lastTurnSeq = -1;
      subscriptionCursor = 0;
    }
    sessionId = nextSessionId;
    if (!sessionId || !token) {
      if (requestId === sessionRequestId) sessionSnapshotPending = false;
      resetMetrics();
      return;
    }
    let hasLocalState = false;
    if (sessionChanged) {
      // 状态立即归位：同页切回过的会话恢复其缓存状态，否则先归空闲，
      // 数字则等快照/本地底数一次性替换，不再把上一会话的状态停在屏幕上
      hasLocalState = restorePanelState(nextSessionId);
      setAgentStatus(hasLocalState ? metrics.agentStatus : 'idle');
      if (hasLocalState) {
        // 恢复计时起点（petUpdateStatus 在状态切换时重置过它），计时保持连续
        petStatusSince = restoredPetStatusSince;
        petClockTick();
        renderAll();
      }
    }
    const targetToken = token;
    try {
      await loadSessionSnapshot(nextSessionId, targetToken, requestId, sessionChanged, hasLocalState);
    } finally {
      // 旧请求结束不能解除新请求的闸门；只有当前请求可以放行 WebSocket。
      if (requestId === sessionRequestId) sessionSnapshotPending = false;
    }
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
    loadUsageDaily({ refreshIfStale: true });
    startSession(initialSessionId);
    quotaTimer = setInterval(fetchQuota, QUOTA_INTERVAL_MS);
    externalTimer = setInterval(fetchExternalProviders, QUOTA_INTERVAL_MS);
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
    else if (sessionId && token && !sessionSnapshotPending && !ws && !reconnectTimer) {
      connectWebSocket();
    }
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
    if (changes[KimiCliUsage.DAILY_STORAGE_KEY]) {
      usageDailyCache = changes[KimiCliUsage.DAILY_STORAGE_KEY].newValue || {};
      renderChart();
      renderPetStats();
    }
    if (changes[KimiCliUsage.STATE_STORAGE_KEY]) {
      cliUsageConnected = changes[KimiCliUsage.STATE_STORAGE_KEY].newValue?.connected === true;
      if (!cliUsageConnected) usageDailyCache = {};
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
    if (message?.type === 'cli.usage.updated') {
      loadUsageDaily();
      // 后台重扫完成：空闲时按最新按会话汇总刷新当前面板底数
      refreshSessionSeedFromScan();
    }
    if (message?.type === 'cli.usage.disconnected') {
      loadUsageDaily();
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
    sessionSnapshotPending = false;
    cancelLongPress();
    clearDrag();
    if (editing) exitEditMode();
    if (petClockTimer) clearInterval(petClockTimer);
    petClockTimer = null;
    petClearIdleAmbient();
    if (petRive) {
      try {
        petRive.cleanup();
      } catch (error) {
        // 忽略
      }
      petRive = null;
      petCanvasEl = null;
      petMotion = '';
      petStarsVisible = false;
      petSwitchingMotion = false;
      petReturnToBase = false;
    }
    petCancelTurn();
    clearToolStatus();
    // 侧栏改造的全局 class 一并移除，避免扩展重载后样式残留无法关闭
    document.documentElement.classList.remove('ksb-sidebar-tidy');
    disconnectWebSocket();
    if (quotaTimer) clearInterval(quotaTimer);
    if (externalTimer) clearInterval(externalTimer);
    externalTimer = null;
    if (pendingStatusTimer) clearTimeout(pendingStatusTimer);
    pendingStatusTimer = null;
    pendingDisplayStatus = null;
    sparkResizeObserver.disconnect();
    if (sparkResizeRaf) cancelAnimationFrame(sparkResizeRaf);
    sparkResizeRaf = 0;
    if (cliRefreshTimer) clearTimeout(cliRefreshTimer);
    cliRefreshTimer = null;
    if (routeTimer) clearInterval(routeTimer);
    if (resetRefetchTimer) clearTimeout(resetRefetchTimer);
    // 扩展重载后 Chrome 不会自动重新注入 content script，
    // 残留脚本退出时一并移除 widget，避免留下一个永远灰色的「僵尸面板」
    if (els?.widget) els.widget.remove();
    // 引导层还注册了 document/window 监听，必须走它自己的 cleanup；DOM 兜底使用真实 id。
    try {
      window.KsbWalkthrough?.stop?.();
    } catch (error) {
      document.getElementById('ksb-walk')?.remove();
    }
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
