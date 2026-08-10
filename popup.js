/**
 * Kimi Web Status Bar — 扩展弹窗
 * Kimi 账户（多账户授权/切换）与本地 CLI 长期统计的管理入口。
 */
(function () {
  'use strict';

  const authHint = document.getElementById('auth-hint');
  const accountAuthBtn = document.getElementById('account-auth-btn');
  const usageSection = document.getElementById('usage-section');
  const cliLock = document.getElementById('cli-lock');
  const cliConnectBtn = document.getElementById('cli-connect-btn');
  const cliReauthBtn = document.getElementById('cli-reauth-btn');
  const cliDisconnectBtn = document.getElementById('cli-disconnect-btn');
  const cliStatusText = document.getElementById('cli-status-text');
  const cliStatusDot = document.getElementById('cli-status-dot');
  const cliPathHelp = document.getElementById('cli-path-help');
  const cliError = document.getElementById('cli-error');

  let pollTimer = null;
  let cliProgressTimer = null;

  document.getElementById('version').textContent = chrome.runtime.getManifest().version;

  /* ---------- 消耗量板块：读取本地 CLI 的可重建按天缓存 ---------- */
  const {
    sumUsageBetween,
    listDayKeysBetween,
    buildHeatmapData,
    formatTokenCount,
    formatPercentage,
    usageDayKey
  } = globalThis.KimiMetrics;

  const usageDataEl = document.querySelector('.usage-data');

  const usageTokensEl = document.getElementById('usage-tokens');
  const usageDayEl = document.getElementById('usage-day');
  const usageChartEl = document.getElementById('usage-chart');
  const usageStartEl = document.getElementById('usage-start');
  const usageEndEl = document.getElementById('usage-end');
  const usageMetricEl = document.getElementById('usage-metric');
  const USAGE_METRIC_STORAGE_KEY = 'kimiPopupUsageMetric';
  const USAGE_METRICS = {
    total: {
      value: (bucket) => Number(bucket?.input || 0) + Number(bucket?.output || 0),
      format: formatTokenCount
    },
    input: { value: (bucket) => Number(bucket?.input || 0), format: formatTokenCount },
    output: { value: (bucket) => Number(bucket?.output || 0), format: formatTokenCount },
    cache: {
      value: (bucket) => Number(bucket?.input) > 0
        ? (Number(bucket?.cacheRead || 0) / Number(bucket.input)) * 100
        : null,
      format: (value) => `${formatPercentage(value)}%`
    }
  };

  let usageDaily = {};
  let cliConnected = false;
  let usageMetric = 'total';

  // 活跃热力图是展示模式而非数值指标，不参与 USAGE_METRICS 的取值/格式化
  function isValidUsageMetric(id) {
    return id === 'heatmap' || Boolean(USAGE_METRICS[id]);
  }

  // 活跃热力图：固定最近 90 天窗口，格子自带悬浮提示，不占用大数字与日期区
  function renderHeatmap() {
    const { weeks } = buildHeatmapData(usageDaily, usageDayKey(new Date()));
    usageChartEl.replaceChildren();
    const grid = document.createElement('div');
    grid.className = 'usage-heatmap';
    for (const week of weeks) {
      const weekEl = document.createElement('span');
      weekEl.className = 'usage-heat-week';
      for (const cell of week) {
        const cellEl = document.createElement('span');
        cellEl.className = 'usage-heat-cell';
        cellEl.dataset.level = cell.level;
        cellEl.title = cell.total > 0
          ? `${cell.key.slice(5)} · ${formatTokenCount(cell.total)} tokens`
          : `${cell.key.slice(5)} · 无记录`;
        weekEl.append(cellEl);
      }
      grid.append(weekEl);
    }
    usageChartEl.append(grid);
  }

  // 大数字与柱图使用同一个按日期可聚合指标；不混入只属于当前会话的速度。
  function renderSummary(bucket, emptyValue = '--') {
    const definition = USAGE_METRICS[usageMetric] || USAGE_METRICS.total;
    const value = definition.value(bucket);
    // 缓存命中率的 0 是真实值（有输入但零命中），显示 0.0% 而非 '--'
    usageTokensEl.textContent = value == null || (value === 0 && usageMetric !== 'cache')
      ? emptyValue
      : definition.format(value);
  }

  function showDay(key) {
    usageDayEl.textContent = key.slice(5);
    const bucket = usageDaily[key];
    if (!bucket) {
      renderSummary(null, usageMetric === 'cache' ? '--' : '0');
      return;
    }
    renderSummary(bucket, usageMetric === 'cache' ? '--' : '0');
  }

  function renderUsage() {
    // 活跃热力图：固定 90 天窗口，忽略日期范围选择器（该模式下选择器已隐藏）
    if (usageMetric === 'heatmap') {
      usageDataEl.classList.add('heatmap-mode');
      renderHeatmap();
      return;
    }
    usageDataEl.classList.remove('heatmap-mode');

    const startKey = usageStartEl.value;
    const endKey = usageEndEl.value;
    if (!startKey || !endKey || startKey > endKey) return;

    const rangeSum = sumUsageBetween(usageDaily, startKey, endKey);
    renderSummary(rangeSum);

    // 范围内所有自然日都画柱子，无记录的天留底线不断流
    const keys = listDayKeysBetween(startKey, endKey);
    const definition = USAGE_METRICS[usageMetric] || USAGE_METRICS.total;
    const values = keys.map((key) => definition.value(usageDaily[key]) || 0);
    const maxValue = usageMetric === 'cache' ? 100 : Math.max(0, ...values);
    usageChartEl.replaceChildren();
    keys.forEach((key, index) => {
      const bucket = usageDaily[key];
      const value = values[index];
      // 缓存命中率为 0 是真实值，要显示 0.0%；只有无输入（null）才显示 '--'
      const rawValue = definition.value(bucket);
      let label = rawValue != null
        ? definition.format(rawValue)
        : usageMetric === 'cache' ? '--' : '0';
      // 消耗量指标展示主/子代理拆分（CLI 扫描按 agents 目录名分桶）
      const sub = bucket?.sub;
      const subTokens = sub ? Number(sub.input || 0) + Number(sub.output || 0) : 0;
      if (usageMetric === 'total' && rawValue > 0 && subTokens > 0) {
        label += `（主 ${formatTokenCount(rawValue - subTokens)} · 子 ${formatTokenCount(subTokens)}）`;
      }
      // 列是满高的悬浮识别区，柱子只是底部的可见部分
      const col = document.createElement('span');
      col.className = 'usage-col';
      col.title = `${key.slice(5)} · ${label}`;
      col.addEventListener('mouseenter', () => showDay(key));
      const stack = document.createElement('span');
      stack.className = 'usage-stack';
      // 消耗量指标下子代理同额堆叠在主代理之上（蓝底绿顶），与面板柱图一致
      const stacked = usageMetric === 'total' && subTokens > 0 && maxValue > 0;
      if (stacked) {
        const subBar = document.createElement('span');
        subBar.className = 'usage-bar sub';
        subBar.style.height = `${(subTokens / maxValue) * 100}%`;
        stack.append(subBar);
      }
      const bar = document.createElement('span');
      bar.className = stacked ? 'usage-bar flat' : 'usage-bar';
      const barValue = stacked ? value - subTokens : value;
      bar.style.height = `${Math.max(3, maxValue > 0 ? (barValue / maxValue) * 100 : 3)}%`;
      stack.append(bar);
      col.append(stack);
      usageChartEl.append(col);
    });
  }

  usageChartEl.addEventListener('mouseleave', () => {
    usageDayEl.textContent = '';
    if (usageMetric === 'heatmap') return;
    const startKey = usageStartEl.value;
    const endKey = usageEndEl.value;
    if (!startKey || !endKey || startKey > endKey) return;
    renderSummary(sumUsageBetween(usageDaily, startKey, endKey));
  });

  async function refreshUsage() {
    try {
      const stored = await chrome.storage.local.get([
        KimiCliUsage.DAILY_STORAGE_KEY,
        USAGE_METRIC_STORAGE_KEY
      ]);
      usageDaily = stored[KimiCliUsage.DAILY_STORAGE_KEY] || {};
      usageMetric = isValidUsageMetric(stored[USAGE_METRIC_STORAGE_KEY])
        ? stored[USAGE_METRIC_STORAGE_KEY]
        : usageMetric;
      usageMetricEl.value = usageMetric;
      // 可选范围：最早有记录的一天 ~ 今天；默认看今日
      const todayKey = usageDayKey(new Date());
      const firstKey = Object.keys(usageDaily).sort()[0] || todayKey;
      for (const input of [usageStartEl, usageEndEl]) {
        input.min = firstKey;
        input.max = todayKey;
      }
      if (!usageStartEl.value) usageStartEl.value = todayKey;
      if (!usageEndEl.value) usageEndEl.value = todayKey;
      renderUsage();
    } catch (error) {
      // 读存储失败不阻塞授权状态展示，数值保持 '--'
    }
  }

  // 起止日期颠倒时自动交换，避免用户卡在无响应状态
  function onRangeChange() {
    if (
      usageStartEl.value &&
      usageEndEl.value &&
      usageStartEl.value > usageEndEl.value
    ) {
      const start = usageStartEl.value;
      usageStartEl.value = usageEndEl.value;
      usageEndEl.value = start;
    }
    renderUsage();
  }

  usageStartEl.addEventListener('change', onRangeChange);
  usageEndEl.addEventListener('change', onRangeChange);
  usageMetricEl.addEventListener('change', () => {
    usageMetric = isValidUsageMetric(usageMetricEl.value) ? usageMetricEl.value : 'total';
    chrome.storage.local.set({ [USAGE_METRIC_STORAGE_KEY]: usageMetric }).catch(() => {});
    usageDayEl.textContent = '';
    renderUsage();
  });

  // CLI 扫描完成或连接状态改变时刷新；WebSocket 不再写长期统计。
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[KimiCliUsage.DAILY_STORAGE_KEY]) refreshUsage();
    if (changes[KimiCliUsage.STATE_STORAGE_KEY]) refreshCliStatus();
  });

  // 导出可重建的 CLI 按日汇总与额度快照，不包含对话原文。
  document.getElementById('export-link').addEventListener('click', async (event) => {
    event.preventDefault();
    const link = event.currentTarget;
    try {
      const stored = await chrome.storage.local.get([
        KimiCliUsage.DAILY_STORAGE_KEY,
        'quotaSnapshots',
        'quotaMonthlyLast'
      ]);
      const payload = {
        exportedAt: new Date().toISOString(),
        note: 'Kimi Code Monitor 统计导出。usageDaily 为 CLI 按天数字汇总。导出不包含 CLI 对话原文。input 为总输入（含缓存读写）。',
        usageDaily: stored[KimiCliUsage.DAILY_STORAGE_KEY] || {},
        quotaSnapshots: stored.quotaSnapshots || {},
        quotaMonthly: stored.quotaMonthlyLast || null
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `kimi-usage-${usageDayKey(new Date())}.json`;
      anchor.click();
      // 个别内核同步回收过早，延迟释放 blob URL
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (error) {
      link.textContent = '导出失败';
      setTimeout(() => {
        link.textContent = '导出统计';
      }, 2_000);
    }
  });

  // 重置面板布局：只删模块配置键；CLI 授权、统计缓存和额度快照一概不动。
  document.getElementById('reset-layout-link').addEventListener('click', async (event) => {
    event.preventDefault();
    const link = event.currentTarget;
    try {
      await chrome.storage.local.remove('kimi-statusbar.config');
      link.textContent = '已重置 ✓';
    } catch (error) {
      link.textContent = '重置失败';
    }
    setTimeout(() => {
      link.textContent = '重置布局';
    }, 2_000);
  });

  function send(type, payload) {
    return chrome.runtime.sendMessage({ type, payload });
  }

  function setCliPathHelp() {
    const platform = String(navigator.userAgentData?.platform || navigator.platform || '').toLowerCase();
    if (platform.includes('mac')) {
      cliPathHelp.innerHTML = '建议路径：<code>~/.kimi-code</code><br>目录选择器中按 <b>⌘⇧.</b> 显示隐藏目录。';
    } else if (platform.includes('win')) {
      cliPathHelp.innerHTML = '建议路径：<code>%USERPROFILE%\\.kimi-code</code><br>可按 <b>Ctrl+L</b> 后粘贴路径并回车。';
    } else {
      cliPathHelp.innerHTML = '建议路径：<code>~/.kimi-code</code><br>目录选择器中按 <b>Ctrl+H</b> 显示隐藏目录。';
    }
  }

  function showCliError(message = '') {
    cliError.textContent = message;
    cliError.classList.toggle('hidden', !message);
  }

  function stopCliProgressPolling() {
    if (cliProgressTimer) clearInterval(cliProgressTimer);
    cliProgressTimer = null;
  }

  function startCliProgressPolling() {
    if (cliProgressTimer) return;
    cliProgressTimer = setInterval(() => refreshCliStatus({ refreshData: false }), 500);
  }

  function setCliUi(connected, state = {}) {
    cliConnected = connected;
    usageSection.classList.toggle('locked', !connected);
    cliLock.classList.toggle('hidden', connected);
    document.getElementById('cli-connected-row').classList.toggle('hidden', !connected);
    if (!connected) {
      stopCliProgressPolling();
      usageDaily = {};
      cliConnectBtn.disabled = false;
      cliConnectBtn.textContent = state.permission === 'prompt' || state.permission === 'denied'
        ? '授权本地 CLI'
        : '连接本地 CLI';
      return;
    }
    const progress = Math.max(0, Math.min(100, Number(state.progress) || 0));
    cliStatusDot.className = `dot ${state.error ? 'bad' : 'ok'}`;
    // 显示真实错误（截断），不再是泛化文案——网络盘断连等原因用户可直接定位
    cliStatusText.textContent = state.error
      ? `读取失败：${String(state.error).slice(0, 80)}`
      : state.scanning
      ? `正在读取本地记录 ${progress}%`
      : '本地记录已授权';
    cliReauthBtn.disabled = state.scanning === true;
    cliDisconnectBtn.disabled = state.scanning === true;
    if (state.scanning) startCliProgressPolling();
    else stopCliProgressPolling();
  }

  async function refreshCliStatus({ refreshData = true } = {}) {
    try {
      const response = await send('cli.usage.status');
      if (!response?.ok) throw new Error(response?.error || '状态读取失败');
      setCliUi(response.connected, response);
      if (response.connected && refreshData && !response.scanning) refreshUsage();
    } catch (error) {
      setCliUi(false);
      cliConnectBtn.textContent = '连接状态异常，请重试';
    }
  }

  async function connectCliUsage() {
    // 工具栏弹窗里调原生目录选择器：Windows 上弹窗会因失焦被系统关闭，
    // 选择后的流程（存句柄、触发扫描）无声中断。转到选项页（完整标签页）完成授权。
    // chrome.tabs.getCurrent() 只在标签页中返回标签，工具栏弹窗里为 undefined
    const hostedTab = await chrome.tabs.getCurrent().catch(() => null);
    if (!hostedTab) {
      await chrome.runtime.openOptionsPage().catch(() => {});
      window.close();
      return;
    }
    if (typeof showDirectoryPicker !== 'function') {
      cliConnectBtn.textContent = '当前 Chrome 不支持目录授权';
      return;
    }
    const wasConnected = cliConnected;
    showCliError();
    cliConnectBtn.disabled = true;
    try {
      // 目录句柄持久但读取权限不持久（浏览器重启后失效）：
      // 有句柄时先直接请求恢复权限，一次点击即可，不必重新选择目录
      const existing = await KimiCliUsage.getDirectoryHandle().catch(() => null);
      if (existing && typeof existing.requestPermission === 'function') {
        cliConnectBtn.textContent = '正在恢复授权…';
        const granted = await existing.requestPermission({ mode: 'read' }).catch(() => 'denied');
        if (granted === 'granted') {
          setCliUi(true, { scanning: true });
          const response = await send('cli.usage.refresh', { force: true });
          if (!response?.ok) throw new Error(response?.error || '本地记录读取失败');
          await refreshCliStatus();
          return;
        }
        // 未获权限则继续走目录选择器
      }
      cliConnectBtn.textContent = '请选择 .kimi-code 文件夹…';
      const handle = await showDirectoryPicker({ id: 'kimi-cli-sessions', mode: 'read' });
      if (handle.name !== '.kimi-code') {
        throw new Error('目录选择错误：请选择 .kimi-code 文件夹。');
      }
      await KimiCliUsage.saveDirectoryHandle(handle);
      setCliUi(true, { scanning: true });
      const response = await send('cli.usage.refresh', { force: true });
      if (!response?.ok) throw new Error(response?.error || '本地记录读取失败');
      await refreshCliStatus();
    } catch (error) {
      if (error?.name === 'AbortError') {
        await refreshCliStatus();
        return;
      }
      await refreshCliStatus();
      if (!wasConnected && !cliConnected) setCliUi(false);
      showCliError(error?.message || '连接失败，请重试');
    } finally {
      cliConnectBtn.disabled = false;
    }
  }

  cliConnectBtn.addEventListener('click', connectCliUsage);
  cliReauthBtn.addEventListener('click', connectCliUsage);
  cliDisconnectBtn.addEventListener('click', async () => {
    cliDisconnectBtn.disabled = true;
    await send('cli.usage.disconnect');
    showCliError();
    await refreshCliStatus();
  });

  /* ---------- Kimi 账户：多账户列表（切换/改名/重新授权/移除/添加） ---------- */

  let kimiAccounts = [];
  let flowActive = false;
  // 授权流程启动前的基线，轮询据此判断流程是真的完成还是超时/被取消
  let flowBaseline = null;
  let sawUnauthorizedDuringFlow = false;

  // 授权流程进行中禁用授权入口，避免重复发起
  function setAuthBusy(disabled) {
    accountAuthBtn.disabled = disabled;
  }

  function renderAuthStatus(response) {
    kimiAccounts = Array.isArray(response?.accounts) ? response.accounts : [];
    renderKimiAccounts();
    buildRenameModelOptions();
  }

  function renderKimiAccounts() {
    const list = document.getElementById('account-list');
    if (!list) return;
    list.replaceChildren();
    // 零账户显示空态「去授权」，有账户才显示「+ 添加账户」
    const hasAccounts = kimiAccounts.length > 0;
    document.getElementById('account-empty').classList.toggle('hidden', hasAccounts);
    document.getElementById('account-add-btn').classList.toggle('hidden', !hasAccounts);
    for (const account of kimiAccounts) {
      const row = document.createElement('div');
      row.className = 'ext-row';

      const name = document.createElement('span');
      name.className = 'ext-name';
      name.textContent = account.needsReauth ? `${account.label}（需重新授权）` : account.label;
      name.title = name.textContent;
      row.append(name);

      const actions = document.createElement('span');
      actions.className = 'status-actions';

      if (account.active) {
        const badge = document.createElement('span');
        badge.className = 'account-badge';
        badge.textContent = '当前';
        actions.append(badge);
      } else {
        actions.append(makeAccountButton('切换', 'action primary', async (button) => {
          const response = await send('accounts.switch', { id: account.id });
          if (!response?.ok) throw new Error(response?.error || '切换失败');
          await refreshStatus();
        }, '切换失败'));
      }

      actions.append(makeAccountButton('改名', 'action', async () => {
        startAccountRename(row, account);
      }));

      if (account.needsReauth) {
        actions.append(makeAccountButton('重新授权', 'action', async () => {
          await startOAuthFlow(
            account.active ? send('oauth.reset') : send('oauth.reauth', { id: account.id })
          );
        }));
      }

      actions.append(makeAccountButton('移除', 'action', async (button) => {
        const response = await send('accounts.remove', { id: account.id });
        if (!response?.ok) throw new Error(response?.error || '移除失败');
        await refreshStatus();
      }, '移除失败'));

      row.append(actions);
      list.append(row);
    }
  }

  // 行内文字按钮：失败时在授权提示区报错并恢复可点
  function makeAccountButton(text, className, onClick, errorPrefix = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = text;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await onClick(button);
      } catch (error) {
        showHint(`${errorPrefix || text}失败：${error.message || error}`);
      } finally {
        button.disabled = false;
      }
    });
    return button;
  }

  // 改名为行内编辑：Enter/保存提交，Escape 取消
  function startAccountRename(row, account) {
    row.replaceChildren();
    const input = document.createElement('input');
    input.type = 'text';
    input.value = account.label;
    input.maxLength = 30;
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'action primary';
    saveBtn.textContent = '保存';
    const submit = async () => {
      const label = input.value.trim();
      if (!label) {
        input.focus();
        return;
      }
      saveBtn.disabled = true;
      try {
        const response = await send('accounts.rename', { id: account.id, label });
        if (!response?.ok) throw new Error(response?.error || '改名失败');
        await refreshStatus();
      } catch (error) {
        showHint(`改名失败：${error.message || error}`);
        saveBtn.disabled = false;
      }
    };
    saveBtn.addEventListener('click', submit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
      if (event.key === 'Escape') renderKimiAccounts();
    });
    row.append(input, saveBtn);
    input.focus();
    input.select();
  }

  async function refreshStatus() {
    try {
      const response = await send('auth.status');
      if (response?.ok && response.authorized) {
        stopPolling();
        setAuthBusy(false);
        renderAuthStatus(response);
      } else if (response?.pending) {
        setAuthBusy(true);
        showHint('请在授权页完成授权。', response.userCode);
        kimiAccounts = Array.isArray(response?.accounts) ? response.accounts : [];
        renderKimiAccounts();
        if (!pollTimer) pollTimer = setInterval(poll, 2_000);
      } else {
        stopPolling();
        setAuthBusy(false);
        renderAuthStatus(response);
      }
    } catch (error) {
      showHint(`状态查询失败：${error.message || error}`);
    }
  }

  function showHint(message, userCode = '') {
    authHint.replaceChildren();
    authHint.append(document.createTextNode(message));
    if (userCode) {
      authHint.append(document.createElement('br'), document.createTextNode('验证码：'));
      const strong = document.createElement('strong');
      strong.textContent = userCode;
      authHint.append(strong);
    }
    authHint.classList.remove('hidden');
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  // 统一的授权流程入口：记录基线、启动流程、开始轮询（添加账户/重新授权共用）
  async function startOAuthFlow(startPromise) {
    if (pollTimer) return;
    setAuthBusy(true);
    showHint('正在打开 Kimi 授权页…');
    try {
      const baseline = await send('auth.status').catch(() => null);
      flowBaseline = {
        activeId: baseline?.activeId || null,
        authorized: Boolean(baseline?.authorized)
      };
      sawUnauthorizedDuringFlow = false;
      flowActive = true;
      const response = await startPromise;
      if (!response?.ok) throw new Error(response?.error || '无法开始授权');
      showHint('已在新标签页打开授权页，请完成授权；关闭本弹窗不影响授权。', response.userCode);
      pollTimer = setInterval(poll, 2_000);
      poll();
    } catch (error) {
      flowActive = false;
      flowBaseline = null;
      showHint(`授权启动失败：${error.message || error}`);
      setAuthBusy(false);
    }
  }

  // 后台在驱动授权轮询，弹窗只需周期性查询授权状态
  async function poll() {
    try {
      const response = await send('auth.status');
      if (response && !response.authorized) sawUnauthorizedDuringFlow = true;
      if (response?.pending) {
        showHint('请在授权页完成授权。', response.userCode);
        return;
      }
      // 后台轮询已结束：授权完成（新账户/新激活/经历过未授权后恢复）或超时取消
      stopPolling();
      const completed = Boolean(response?.authorized) && flowActive && (
        !flowBaseline?.authorized ||
        sawUnauthorizedDuringFlow ||
        response.activeId !== flowBaseline?.activeId
      );
      flowActive = false;
      flowBaseline = null;
      if (completed) {
        showHint('授权成功，状态栏会自动恢复显示。');
      } else {
        showHint('授权未完成（已超时或被取消），请重试。');
      }
      setAuthBusy(false);
      renderAuthStatus(response);
    } catch (error) {
      stopPolling();
      flowActive = false;
      flowBaseline = null;
      showHint(`状态查询失败：${error.message || error}`);
      setAuthBusy(false);
    }
  }

  // 零账户空态的「去授权」：直接走添加账户流程（备注名留空，授权后可改）
  accountAuthBtn.addEventListener('click', () => {
    startOAuthFlow(send('oauth.add', { label: '' }));
  });

  // 添加账户：先填备注名（可留空），再走设备授权流程；授权后仍可改名
  const accountAddBtn = document.getElementById('account-add-btn');
  const accountAddPanel = document.getElementById('account-add');
  const accountLabelInput = document.getElementById('account-label-input');
  accountAddBtn.addEventListener('click', () => {
    accountAddPanel.classList.toggle('hidden');
    accountAddBtn.classList.toggle('hidden', !accountAddPanel.classList.contains('hidden'));
    accountLabelInput.focus();
  });
  document.getElementById('account-add-save').addEventListener('click', async () => {
    const label = accountLabelInput.value.trim();
    accountAddPanel.classList.add('hidden');
    accountAddBtn.classList.remove('hidden');
    accountLabelInput.value = '';
    await startOAuthFlow(send('oauth.add', { label }));
  });

  /* ---------- 外部账户：加号添加（选类型 + 粘贴 key），列表管理 ---------- */

  function formatExternalStatus(provider) {
    if (provider.error) return { text: `获取失败：${provider.error}`, isError: true };
    if (provider.kind === 'balance') {
      return {
        text: `余额 ${provider.currency}${provider.total.toFixed(2)}（赠送 ${provider.granted.toFixed(2)} · 充值 ${provider.paid.toFixed(2)}）`,
        isError: false
      };
    }
    if (provider.windows?.length) {
      return {
        text: provider.windows.map((w) => `${w.label} ${w.pct.toFixed(1)}%`).join(' · '),
        isError: false
      };
    }
    return { text: provider.plan || '已启用', isError: false };
  }

  let externalAccountsCache = [];

  function renderExternalAccounts(errorMessage = '') {
    const list = document.getElementById('external-list');
    if (!list) return;
    list.replaceChildren();
    for (const account of externalAccountsCache) {
      const row = document.createElement('div');
      row.className = 'ext-row';

      // textContent 赋值，名称/尾号不经 innerHTML，无注入面
      const name = document.createElement('span');
      name.className = 'ext-name';
      name.textContent = account.keyTail ? `${account.name} · ${account.keyTail}` : account.name;
      name.title = name.textContent;
      row.append(name);

      const actions = document.createElement('span');
      actions.className = 'status-actions';

      const renameBtn = document.createElement('button');
      renameBtn.type = 'button';
      renameBtn.className = 'action';
      renameBtn.textContent = '改名';
      renameBtn.addEventListener('click', () => startExternalRename(row, account));
      actions.append(renameBtn);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'action';
      removeBtn.textContent = '移除';
      removeBtn.addEventListener('click', async () => {
        removeBtn.disabled = true;
        try {
          const response = await send('external.remove', { id: account.id });
          if (!response?.ok) throw new Error(response?.error || '移除失败');
          externalAccountsCache = externalAccountsCache.filter((a) => a.id !== account.id);
          renderExternalAccounts();
        } catch (error) {
          renderExternalAccounts(`移除失败：${error?.message || error}`);
        }
      });
      actions.append(removeBtn);

      row.append(actions);
      list.append(row);
    }
    if (errorMessage) {
      const errEl = document.createElement('div');
      errEl.className = 'ext-status err';
      errEl.textContent = errorMessage;
      list.append(errEl);
    }
  }

  // 外部账户行内改名：Enter/保存提交，Escape 取消；label 由后台保存并覆盖 provider 默认名
  function startExternalRename(row, account) {
    row.replaceChildren();
    const input = document.createElement('input');
    input.type = 'text';
    input.value = account.name;
    input.maxLength = 30;
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'action primary';
    saveBtn.textContent = '保存';
    const submit = async () => {
      const label = input.value.trim();
      if (!label) {
        input.focus();
        return;
      }
      saveBtn.disabled = true;
      try {
        const response = await send('external.rename', { id: account.id, label });
        if (!response?.ok) throw new Error(response?.error || '改名失败');
        await refreshExternalStatus();
      } catch (error) {
        renderExternalAccounts(`改名失败：${error?.message || error}`);
      }
    };
    saveBtn.addEventListener('click', submit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
      if (event.key === 'Escape') renderExternalAccounts();
    });
    row.append(input, saveBtn);
    input.focus();
    input.select();
  }

  async function refreshExternalStatus() {
    try {
      const response = await send('external.status');
      if (!response?.ok) return;
      externalAccountsCache = response.providers || [];
      renderExternalAccounts();
      buildRenameModelOptions();
    } catch (error) {
      // 状态拉取失败不阻塞其他区块
    }
  }

  function buildExternalSection() {
    const select = document.getElementById('ext-provider-select');
    if (!select || !globalThis.KimiExternalProviders) return;
    for (const [id, provider] of Object.entries(KimiExternalProviders.PROVIDERS)) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = `${provider.name}（${provider.typeLabel}）`;
      select.append(option);
    }
    const addPanel = document.getElementById('external-add');
    const addBtn = document.getElementById('ext-add-btn');
    const keyInput = document.getElementById('ext-key-input');
    const status = document.getElementById('ext-add-status');
    addBtn.addEventListener('click', () => {
      addPanel.classList.toggle('hidden');
      addBtn.classList.toggle('hidden', !addPanel.classList.contains('hidden'));
      keyInput.focus();
    });
    document.getElementById('ext-add-save').addEventListener('click', async (event) => {
      const providerId = select.value;
      const provider = KimiExternalProviders.PROVIDERS[providerId];
      const key = keyInput.value.trim();
      if (!key) {
        status.textContent = '请先粘贴 API Key';
        status.classList.add('err');
        return;
      }
      const button = event.currentTarget;
      button.disabled = true;
      status.classList.remove('err');
      status.textContent = '正在验证…';
      try {
        // 域名权限必须在用户手势里申请（optional_host_permissions）
        const granted = await chrome.permissions.request({ origins: [`${provider.origin}/*`] });
        if (!granted) throw new Error('未授予域名访问权限');
        const response = await send('external.add', { provider: providerId, key });
        if (!response?.ok) throw new Error(response?.error || '保存失败');
        const result = formatExternalStatus(response.provider || {});
        status.textContent = result.isError ? result.text : '已保存';
        status.classList.toggle('err', result.isError);
        keyInput.value = '';
        await refreshExternalStatus();
      } catch (error) {
        status.textContent = error?.message || String(error);
        status.classList.add('err');
      } finally {
        button.disabled = false;
      }
    });
  }

  /* ---------- AI 会话标题：模型选择、开关持久化、批量发起与进度 ---------- */

  const RENAME_SETTINGS_STORAGE_KEY = 'sessionRenameSettings';
  const RENAME_MODELS_STORAGE_KEY = 'sessionRenameModels';
  const renameShared = globalThis.KimiSessionRename;
  const renameModelSelect = document.getElementById('rename-model-select');
  const renameEmojiToggle = document.getElementById('rename-emoji-toggle');
  const renameAutoToggle = document.getElementById('rename-auto-toggle');
  const renameUsage = document.getElementById('rename-usage');
  let renameSettings = {
    autoEnabled: false,
    emojiEnabled: true,
    modelSource: renameShared.defaultModelSource()
  };
  // Kimi Code 模型清单：先渲染缓存/硬编码兜底，弹窗打开时后台刷新
  let renameModelsCache = renameShared.KIMI_CODE_FALLBACK_MODELS;

  // 命名 token 用量累计（每次模型调用的响应 usage 由 background 累加）
  async function refreshRenameUsage() {
    try {
      const response = await send('rename.usage.get');
      const usage = response?.usage;
      renameUsage.textContent = usage?.calls > 0
        ? `累计命名 ${usage.calls} 次 · 输入 ${formatTokenCount(usage.input)} · 输出 ${formatTokenCount(usage.output)} tokens`
        : '';
    } catch (error) {
      renameUsage.textContent = '';
    }
  }

  function saveRenameSettings() {
    chrome.storage.local.set({ [RENAME_SETTINGS_STORAGE_KEY]: renameSettings }).catch(() => {});
  }

  // <select> 的字符串 value 与 modelSource 对象互转
  function modelSourceToValue(source) {
    return source.kind === 'external' ? `ext:${source.accountId}` : `kimi-code:${source.model}`;
  }

  function valueToModelSource(value) {
    if (typeof value === 'string' && value.startsWith('kimi-code:')) {
      return { kind: 'kimi-code', model: value.slice('kimi-code:'.length) };
    }
    return renameShared.normalizeModelSource(value);
  }

  // 扁平下拉：Kimi Code 各模型（display_name）在前，已配置的外部账户在后，不按账户分组
  function buildRenameModelOptions() {
    const previousValue = modelSourceToValue(renameSettings.modelSource);
    renameModelSelect.replaceChildren();
    for (const entry of renameModelsCache) {
      const option = document.createElement('option');
      option.value = `kimi-code:${entry.model}`;
      option.textContent = `${entry.display_name}（Kimi Code）`;
      renameModelSelect.append(option);
    }
    const supported = globalThis.KimiSessionRenameModel?.RENAME_MODEL_PROVIDERS || {};
    for (const account of externalAccountsCache) {
      if (!supported[account.provider]) continue;
      const providerName =
        globalThis.KimiExternalProviders?.PROVIDERS?.[account.provider]?.name || account.provider;
      const option = document.createElement('option');
      option.value = `ext:${account.id}`;
      // 「DeepSeek · 备注名」：未改名时只显示 provider 名
      option.textContent =
        account.name && account.name !== providerName
          ? `${providerName} · ${account.name}`
          : providerName;
      renameModelSelect.append(option);
    }
    const values = [...renameModelSelect.options].map((option) => option.value);
    const nextValue = values.includes(previousValue) ? previousValue : values[0];
    if (nextValue) {
      renameModelSelect.value = nextValue;
      renameSettings.modelSource = valueToModelSource(nextValue);
    }
  }

  async function loadRenameSettings() {
    try {
      const stored = await chrome.storage.local.get(RENAME_SETTINGS_STORAGE_KEY);
      const raw = stored[RENAME_SETTINGS_STORAGE_KEY];
      renameSettings = { ...renameSettings, ...(raw || {}) };
      renameSettings.modelSource = renameShared.normalizeModelSource(renameSettings.modelSource);
      // 旧默认 Highspeed 一次性迁移到 K2.7 Coding（单价更低）；用户之后手选 Highspeed 不回退
      const migration = await chrome.storage.local.get('sessionRenameModelV2').catch(() => ({}));
      if (!migration.sessionRenameModelV2) {
        if (renameSettings.modelSource?.model === 'kimi-code/kimi-for-coding-highspeed') {
          renameSettings.modelSource = { kind: 'kimi-code', model: 'kimi-code/kimi-for-coding' };
          saveRenameSettings();
        }
        chrome.storage.local.set({ sessionRenameModelV2: true }).catch(() => {});
      }
      renameEmojiToggle.checked = renameSettings.emojiEnabled !== false;
      renameAutoToggle.checked = renameSettings.autoEnabled === true;
      // 旧版字符串 modelSource（'kimi' / 'ext:<id>'）迁移为新结构后回写一次
      if (raw && JSON.stringify(raw.modelSource) !== JSON.stringify(renameSettings.modelSource)) {
        saveRenameSettings();
      }
    } catch (error) {
      // 读取失败用默认设置
    }
  }

  // 模型清单：先用缓存渲染，再经 background 中继向 Kimi Code Web 页面拉最新值
  async function loadRenameModels() {
    try {
      const stored = await chrome.storage.local.get(RENAME_MODELS_STORAGE_KEY);
      const cached = stored[RENAME_MODELS_STORAGE_KEY];
      if (Array.isArray(cached) && cached.length) renameModelsCache = cached;
    } catch (error) {
      // 读缓存失败用兜底
    }
    buildRenameModelOptions();
    try {
      const response = await send('rename.models.list');
      if (response?.ok && Array.isArray(response.models) && response.models.length) {
        renameModelsCache = response.models;
        chrome.storage.local.set({ [RENAME_MODELS_STORAGE_KEY]: response.models }).catch(() => {});
        buildRenameModelOptions();
      }
    } catch (error) {
      // 页面未打开/拉取失败：保持缓存或兜底
    }
  }

  renameModelSelect.addEventListener('change', () => {
    renameSettings.modelSource = valueToModelSource(renameModelSelect.value);
    saveRenameSettings();
  });
  renameEmojiToggle.addEventListener('change', () => {
    renameSettings.emojiEnabled = renameEmojiToggle.checked;
    saveRenameSettings();
  });
  renameAutoToggle.addEventListener('change', () => {
    renameSettings.autoEnabled = renameAutoToggle.checked;
    saveRenameSettings();
  });

  refreshStatus();
  setCliPathHelp();
  refreshCliStatus();
  buildExternalSection();
  refreshExternalStatus();
  loadRenameSettings().then(loadRenameModels);
  refreshRenameUsage();
})();