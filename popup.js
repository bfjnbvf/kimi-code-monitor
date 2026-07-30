/**
 * Kimi Web Status Bar — 扩展弹窗
 * 显示授权状态，提供「重新授权 / 切换账户」入口（设备码 OAuth 流程）。
 */
(function () {
  'use strict';

  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const authHint = document.getElementById('auth-hint');
  const reauthBtn = document.getElementById('reauth-btn');

  let pollTimer = null;

  document.getElementById('version').textContent = chrome.runtime.getManifest().version;

  /* ---------- 消耗量板块：读取 background 按天累计的 usageDaily ---------- */
  const {
    sumUsageBetween,
    listDayKeysBetween,
    formatTokenCount,
    usageDayKey
  } = globalThis.KimiMetrics;

  const usageTokensEl = document.getElementById('usage-tokens');
  const usageHitEl = document.getElementById('usage-hit');
  const usageDayEl = document.getElementById('usage-day');
  const usageChartEl = document.getElementById('usage-chart');
  const usageStartEl = document.getElementById('usage-start');
  const usageEndEl = document.getElementById('usage-end');

  let usageDaily = {};

  // 大数字：rangeSum 为范围合计；悬停单日时「消耗量」标题后显示该日期
  function renderSummary({ totalTokens, cacheHitRate }) {
    usageTokensEl.textContent = totalTokens > 0 ? formatTokenCount(totalTokens) : '--';
    usageHitEl.textContent =
      cacheHitRate != null ? `缓存命中 ${Math.round(cacheHitRate * 100)}%` : '';
  }

  function showDay(key) {
    usageDayEl.textContent = key.slice(5);
    const bucket = usageDaily[key];
    if (!bucket) {
      renderSummary({ totalTokens: 0, cacheHitRate: null });
      usageTokensEl.textContent = '0';
      return;
    }
    renderSummary({
      totalTokens: bucket.input + bucket.output,
      cacheHitRate: bucket.input > 0 ? bucket.cacheRead / bucket.input : null
    });
  }

  function renderUsage() {
    const startKey = usageStartEl.value;
    const endKey = usageEndEl.value;
    if (!startKey || !endKey || startKey > endKey) return;

    const rangeSum = sumUsageBetween(usageDaily, startKey, endKey);
    renderSummary(rangeSum);

    // 范围内所有自然日都画柱子，无记录的天留底线不断流
    const keys = listDayKeysBetween(startKey, endKey);
    const maxTokens = Math.max(
      0,
      ...keys.map((key) => {
        const bucket = usageDaily[key];
        return bucket ? bucket.input + bucket.output : 0;
      })
    );
    usageChartEl.replaceChildren();
    for (const key of keys) {
      const bucket = usageDaily[key];
      const tokens = bucket ? bucket.input + bucket.output : 0;
      // sub 子桶存在时拆分主/子代理，堆叠展示（主在底、子在上）
      const subTokens = bucket?.sub ? bucket.sub.input + bucket.sub.output : 0;
      const mainTokens = tokens - subTokens;
      // 列是满高的悬浮识别区，柱子只是底部的可见部分
      const col = document.createElement('span');
      col.className = 'usage-col';
      col.title = subTokens > 0
        ? `${key.slice(5)} · 主 ${formatTokenCount(mainTokens)} · 子 ${formatTokenCount(subTokens)}`
        : `${key.slice(5)} · ${formatTokenCount(tokens)}`;
      col.addEventListener('mouseenter', () => showDay(key));
      const stack = document.createElement('span');
      stack.className = 'usage-stack';
      if (subTokens > 0 && maxTokens > 0) {
        const subBar = document.createElement('span');
        subBar.className = 'usage-bar sub';
        subBar.style.height = `${(subTokens / maxTokens) * 100}%`;
        stack.append(subBar);
      }
      const mainBar = document.createElement('span');
      mainBar.className = subTokens > 0 ? 'usage-bar flat' : 'usage-bar';
      mainBar.style.height = `${Math.max(3, maxTokens > 0 ? (mainTokens / maxTokens) * 100 : 3)}%`;
      stack.append(mainBar);
      col.append(stack);
      usageChartEl.append(col);
    }
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
      const stored = await chrome.storage.local.get('usageDaily');
      usageDaily = stored.usageDaily || {};
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

  // 弹窗打开期间有新消耗入账时实时刷新
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.usageDaily) refreshUsage();
  });

  // 导出按天累计数据为 JSON 文件
  document.getElementById('export-link').addEventListener('click', async (event) => {
    event.preventDefault();
    const stored = await chrome.storage.local.get('usageDaily');
    const payload = {
      exportedAt: new Date().toISOString(),
      note: 'Kimi Code Monitor 按天累计的 Kimi Code Web 会话 token 消耗（input 为总输入，含缓存读写；sub 为其中子代理的消耗）',
      usageDaily: stored.usageDaily || {}
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `kimi-usage-${usageDayKey(new Date())}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  });

  function send(type) {
    return chrome.runtime.sendMessage({ type });
  }

  function setStatus(authorized, detail) {
    statusDot.className = `dot ${authorized ? 'ok' : 'bad'}`;
    statusText.textContent = authorized
      ? `已授权${detail ? ` · ${detail}` : ''}`
      : '未授权';
    reauthBtn.textContent = authorized ? '切换' : '去授权';
    reauthBtn.classList.toggle('primary', !authorized);
  }

  // 「至 7-28 15:30」式紧凑到期时间
  function formatExpiry(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `至 ${d.getMonth() + 1}-${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  async function refreshStatus() {
    try {
      const response = await send('auth.status');
      if (response?.ok && response.authorized) {
        stopPolling();
        reauthBtn.disabled = false;
        const expiry = response.expiresAt ? formatExpiry(response.expiresAt) : '';
        setStatus(true, expiry);
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

  refreshStatus();
  refreshUsage();
})();
