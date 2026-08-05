/**
 * Kimi Web Status Bar — 扩展弹窗
 * 显示授权状态，提供重新授权入口（设备码 OAuth 流程）。
 */
(function () {
  'use strict';

  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const authHint = document.getElementById('auth-hint');
  const reauthBtn = document.getElementById('reauth-btn');
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
    formatTokenCount,
    formatPercentage,
    usageDayKey
  } = globalThis.KimiMetrics;

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
      usageMetric = USAGE_METRICS[stored[USAGE_METRIC_STORAGE_KEY]]
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
    usageMetric = USAGE_METRICS[usageMetricEl.value] ? usageMetricEl.value : 'total';
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

  function setStatus(authorized) {
    statusDot.className = `dot ${authorized ? 'ok' : 'bad'}`;
    statusText.textContent = authorized ? '额度接口已授权' : '额度接口未授权';
    reauthBtn.textContent = authorized ? '重新授权' : '去授权';
    reauthBtn.classList.toggle('primary', !authorized);
  }

  async function refreshStatus() {
    try {
      const response = await send('auth.status');
      if (response?.ok && response.authorized) {
        stopPolling();
        reauthBtn.disabled = false;
        setStatus(true);
      } else if (response?.pending) {
        reauthBtn.disabled = true;
        statusDot.className = 'dot bad';
        statusText.textContent = '授权流程进行中…';
        showHint('请在授权页完成授权。', response.userCode);
        if (!pollTimer) pollTimer = setInterval(poll, 2_000);
      } else {
        stopPolling();
        reauthBtn.disabled = false;
        setStatus(false);
      }
    } catch (error) {
      statusDot.className = 'dot bad';
      statusText.textContent = `状态查询失败：${error.message || error}`;
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

  function hideHint() {
    authHint.classList.add('hidden');
    authHint.textContent = '';
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  // 后台在驱动授权轮询，弹窗只需周期性查询授权状态
  async function poll() {
    try {
      const response = await send('auth.status');
      if (response?.authorized) {
        stopPolling();
        showHint('授权成功，状态栏会自动恢复显示。');
        reauthBtn.disabled = false;
        setStatus(true);
        return;
      }
      if (response && !response.pending && !response.authorized) {
        // 后台轮询已结束（超时或失败）
        stopPolling();
        showHint('授权未完成（已超时或被取消），请重试。');
        reauthBtn.disabled = false;
        // 顶部状态行同步回「未授权」，不停留在「授权流程进行中…」
        setStatus(false);
      }
    } catch (error) {
      stopPolling();
      showHint(`状态查询失败：${error.message || error}`);
      reauthBtn.disabled = false;
    }
  }

  reauthBtn.addEventListener('click', async () => {
    if (pollTimer) return;
    reauthBtn.disabled = true;
    showHint('正在打开 Kimi 授权页…');
    try {
      const response = await send('oauth.reset');
      if (!response?.ok) throw new Error(response?.error || '无法开始授权');
      showHint('已在新标签页打开授权页，请完成授权；关闭本弹窗不影响授权。', response.userCode);
      pollTimer = setInterval(poll, 2_000);
      poll();
    } catch (error) {
      showHint(`授权启动失败：${error.message || error}`);
      reauthBtn.disabled = false;
    }
  });

  document.getElementById('clear-btn').addEventListener('click', async () => {
    stopPolling();
    hideHint();
    try {
      await send('auth.clear');
      showHint('授权已清除。Kimi Code Web 页面上的新手引导会重新出现，状态栏将回到待授权状态。');
    } catch (error) {
      showHint(`清除失败：${error.message || error}`);
    }
    refreshStatus();
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

  function renderExternalAccounts() {
    const list = document.getElementById('external-list');
    if (!list) return;
    list.replaceChildren();
    for (const account of externalAccountsCache) {
      const wrap = document.createElement('div');
      wrap.innerHTML = `
        <div class="ext-row">
          <span class="ext-name">${account.name} ·${account.keyTail || ''}</span>
          <button type="button" class="action" data-remove="${account.id}">删除</button>
        </div>`;
      wrap.querySelector('[data-remove]').addEventListener('click', async () => {
        await send('external.remove', { id: account.id });
        externalAccountsCache = externalAccountsCache.filter((a) => a.id !== account.id);
        renderExternalAccounts();
      });
      list.append(wrap);
    }
  }

  async function refreshExternalStatus() {
    try {
      const response = await send('external.status');
      if (!response?.ok) return;
      externalAccountsCache = response.providers || [];
      renderExternalAccounts();
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

  refreshStatus();
  setCliPathHelp();
  refreshCliStatus();
  buildExternalSection();
  refreshExternalStatus();
})();
