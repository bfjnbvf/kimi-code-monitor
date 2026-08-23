/**
 * 消耗量板块：本地 CLI 连接/状态、按天图表、活跃热力图、数据导出与布局重置。
 */
import * as KimiMetrics from '../metrics.js';
import * as KimiCliUsage from '../cli-usage.js';
import {
  send,
  CLI_PROGRESS_INTERVAL_MS,
  UI_MESSAGE_RESET_MS,
  BLOB_URL_REVOKE_MS,
  pageState
} from './shared.js';
import { t } from '../i18n.js';

  const usageSection = document.getElementById('usage-section');
  const cliLock = document.getElementById('cli-lock');
  const cliConnectBtn = document.getElementById('cli-connect-btn');
  const cliReauthBtn = document.getElementById('cli-reauth-btn');
  const cliDisconnectBtn = document.getElementById('cli-disconnect-btn');
  const cliStatusText = document.getElementById('cli-status-text');
  const cliStatusDot = document.getElementById('cli-status-dot');
  const cliPathHelp = document.getElementById('cli-path-help');
  const cliError = document.getElementById('cli-error');

  let cliProgressTimer = null;
  let cliScanning = false;

  /* ---------- 消耗量板块：读取本地 CLI 的可重建按天缓存 ---------- */
  const {
    sumUsageBetween,
    listDayKeysBetween,
    buildHeatmapData,
    formatTokenCount,
    formatPercentage,
    usageDayKey
  } = KimiMetrics;

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
  // 默认展示活跃热力图（140 天窗口）；用户切换后按 kimiPopupUsageMetric 持久化
  let usageMetric = 'heatmap';

  // 活跃热力图：140 天（约 20 周）窗口；格子边长按实际列数算出（--heat-cell），
  // 严格正方形且精确铺满 212px 内容宽，版式与其他指标一致
  const HEATMAP_DAYS = 140;
  const HEATMAP_INNER_PX = 212;
  const HEATMAP_GAP_PX = 2;

  // 活跃热力图是展示模式而非数值指标，不参与 USAGE_METRICS 的取值/格式化
  function isValidUsageMetric(id) {
    return id === 'heatmap' || Boolean(USAGE_METRICS[id]);
  }

  // 活跃热力图：固定最近 140 天窗口，格子自带悬浮提示，不占用日期区；
  // 大数字显示该窗口的总消耗，保证与其他指标的版式一致
  function renderHeatmap() {
    const { weeks } = buildHeatmapData(usageDaily, usageDayKey(new Date()), HEATMAP_DAYS);
    usageChartEl.replaceChildren();
    let totalSum = 0;
    const grid = document.createElement('div');
    grid.className = 'usage-heatmap';
    // 格子边长按列数精确计算：正方形且铺满卡片内容宽度（212px）
    const cell = (HEATMAP_INNER_PX - (weeks.length - 1) * HEATMAP_GAP_PX) / weeks.length;
    grid.style.setProperty('--heat-cell', `${cell.toFixed(2)}px`);
    // 空白格：首列顶到首日的星期序、末列补满 7 格，热力图始终是完整矩形
    const blankCell = () => {
      const el = document.createElement('span');
      el.className = 'usage-heat-cell usage-heat-blank';
      return el;
    };
    for (const [weekIndex, week] of weeks.entries()) {
      const weekEl = document.createElement('span');
      weekEl.className = 'usage-heat-week';
      const padTop = weekIndex === 0 ? 7 - week.length : 0;
      const padBottom = weekIndex === weeks.length - 1 ? 7 - week.length : 0;
      for (let i = 0; i < padTop; i += 1) weekEl.append(blankCell());
      for (const cell of week) {
        totalSum += cell.total;
        const cellEl = document.createElement('span');
        cellEl.className = 'usage-heat-cell';
        cellEl.dataset.level = cell.level;
        cellEl.title = cell.total > 0
          ? `${cell.key.slice(5)} · ${formatTokenCount(cell.total)} tokens`
          : t('{date} · 无记录', { date: cell.key.slice(5) });
        weekEl.append(cellEl);
      }
      for (let i = 0; i < padBottom; i += 1) weekEl.append(blankCell());
      grid.append(weekEl);
    }
    usageChartEl.append(grid);
    usageTokensEl.textContent = totalSum > 0 ? formatTokenCount(totalSum) : '--';
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
    // 活跃热力图：固定 140 天窗口，忽略日期范围选择器（该模式下选择器已隐藏）
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
        label += t('（主 {main} · 子 {sub}）', { main: formatTokenCount(rawValue - subTokens), sub: formatTokenCount(subTokens) });
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
      // 读存储失败不阻塞授权状态展示，但给出可感知提示而非永久 '--'
      console.warn('读取用量统计失败:', error);
      usageTokensEl.textContent = t('读取失败');
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
    usageMetric = isValidUsageMetric(usageMetricEl.value) ? usageMetricEl.value : 'heatmap';
    chrome.storage.local.set({ [USAGE_METRIC_STORAGE_KEY]: usageMetric }).catch(() => {});
    usageDayEl.textContent = '';
    renderUsage();
  });

  // CLI 扫描完成或连接状态改变时刷新；WebSocket 不再写长期统计。
  function onStorageChanged(changes, area) {
    if (area !== 'local') return;
    if (changes[KimiCliUsage.DAILY_STORAGE_KEY]) refreshUsage();
    if (changes[KimiCliUsage.STATE_STORAGE_KEY]) refreshCliStatus();
  }
  chrome.storage.onChanged.addListener(onStorageChanged);

  // options 标签页生命周期长，页面隐藏/关闭时清理轮询与监听；
  // 弹窗关闭后脚本即终止，但统一清理无害。
  function cleanupPage() {
    pageState.pageDestroyed = true;
    stopCliProgressPolling();
    chrome.storage.onChanged.removeListener(onStorageChanged);
  }
  window.addEventListener('pagehide', cleanupPage);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopCliProgressPolling();
    } else if (cliScanning && cliConnected) {
      startCliProgressPolling();
    }
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
      setTimeout(() => URL.revokeObjectURL(url), BLOB_URL_REVOKE_MS);
    } catch (error) {
      link.textContent = t('导出失败');
      setTimeout(() => {
        link.textContent = t('导出统计');
      }, UI_MESSAGE_RESET_MS);
    }
  });

  // 重置面板布局：只删模块配置键；CLI 授权、统计缓存和额度快照一概不动。
  document.getElementById('reset-layout-link').addEventListener('click', async (event) => {
    event.preventDefault();
    const link = event.currentTarget;
    try {
      await chrome.storage.local.remove('kimi-statusbar.config');
      link.textContent = t('已重置 ✓');
    } catch (error) {
      link.textContent = t('重置失败');
    }
    setTimeout(() => {
      link.textContent = t('重置布局');
    }, UI_MESSAGE_RESET_MS);
  });



  export function setCliPathHelp() {
    const platform = String(navigator.userAgentData?.platform || navigator.platform || '').toLowerCase();
    if (platform.includes('mac')) {
      cliPathHelp.innerHTML = t('建议路径：<code>~/.kimi-code</code><br>目录选择器中按 <b>⌘⇧.</b> 显示隐藏目录。');
    } else if (platform.includes('win')) {
      cliPathHelp.innerHTML = t('建议路径：<code>%USERPROFILE%\\.kimi-code</code><br>可按 <b>Ctrl+L</b> 后粘贴路径并回车。');
    } else {
      cliPathHelp.innerHTML = t('建议路径：<code>~/.kimi-code</code><br>目录选择器中按 <b>Ctrl+H</b> 显示隐藏目录。');
    }
  }

  function showCliError(message = '') {
    cliError.textContent = message;
    cliError.classList.toggle('hidden', !message);
  }

  function stopCliProgressPolling() {
    if (cliProgressTimer) clearTimeout(cliProgressTimer);
    cliProgressTimer = null;
  }

  // 串行轮询：上一次响应回来才排下一次，避免请求堆积；页面隐藏时停止。
  function startCliProgressPolling() {
    if (cliProgressTimer || pageState.pageDestroyed) return;
    cliProgressTimer = setTimeout(cliProgressPoll, CLI_PROGRESS_INTERVAL_MS);
  }

  async function cliProgressPoll() {
    cliProgressTimer = null;
    if (pageState.pageDestroyed || document.hidden) return;
    try {
      await refreshCliStatus({ refreshData: false });
    } catch (error) {
      // 单次轮询失败不重排，等可见性恢复或下次状态刷新
      return;
    }
    if (cliScanning && cliConnected && !pageState.pageDestroyed) {
      startCliProgressPolling();
    }
  }

  function setCliUi(connected, state = {}) {
    cliConnected = connected;
    cliScanning = connected && state.scanning === true;
    usageSection.classList.toggle('locked', !connected);
    cliLock.classList.toggle('hidden', connected);
    document.getElementById('cli-connected-row').classList.toggle('hidden', !connected);
    if (!connected) {
      stopCliProgressPolling();
      usageDaily = {};
      cliConnectBtn.disabled = false;
      cliConnectBtn.textContent = state.permission === 'prompt' || state.permission === 'denied'
        ? t('授权本地 CLI')
        : t('连接本地 CLI');
      return;
    }
    const progress = Math.max(0, Math.min(100, Number(state.progress) || 0));
    cliStatusDot.className = `dot ${state.error ? 'bad' : 'ok'}`;
    // 显示真实错误（截断），不再是泛化文案——网络盘断连等原因用户可直接定位
    cliStatusText.textContent = state.error
      ? t('读取失败：{msg}', { msg: String(state.error).slice(0, 80) })
      : cliScanning
      ? t('正在读取本地记录 {pct}%', { pct: progress })
      : t('本地记录已授权');
    cliReauthBtn.disabled = cliScanning;
    cliDisconnectBtn.disabled = cliScanning;
    if (cliScanning) startCliProgressPolling();
    else stopCliProgressPolling();
  }

  export async function refreshCliStatus({ refreshData = true } = {}) {
    try {
      const response = await send('cli.usage.status');
      if (!response?.ok) throw new Error(response?.error || t('状态读取失败'));
      setCliUi(response.connected, response);
      if (response.connected && refreshData && !response.scanning) refreshUsage();
    } catch (error) {
      setCliUi(false);
      cliConnectBtn.textContent = t('连接状态异常，请重试');
      showCliError(error?.message || t('连接状态异常，请重试'));
    }
  }

  // 保存句柄后触发后台扫描并刷新状态；两个分支共用。
  async function scanCliUsage(force = false) {
    setCliUi(true, { scanning: true });
    const response = await send('cli.usage.refresh', { force });
    if (!response?.ok) throw new Error(response?.error || t('本地记录读取失败'));
    await refreshCliStatus();
  }

  async function connectCliUsage() {
    // 工具栏弹窗里调原生目录选择器：Windows 上弹窗会因失焦被系统关闭，
    // 选择后的流程（存句柄、触发扫描）无声中断。转到选项页（完整标签页）完成授权。
    if (!pageState.isOptionsTab) {
      await chrome.runtime.openOptionsPage().catch(() => {});
      window.close();
      return;
    }
    if (typeof showDirectoryPicker !== 'function') {
      cliConnectBtn.textContent = t('当前 Chrome 不支持目录授权');
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
        cliConnectBtn.textContent = t('正在恢复授权…');
        const granted = await existing.requestPermission({ mode: 'read' }).catch(() => 'denied');
        if (granted === 'granted') {
          await scanCliUsage(true);
          return;
        }
        // 未获权限则继续走目录选择器
      }
      cliConnectBtn.textContent = t('请选择 .kimi-code 文件夹…');
      const handle = await showDirectoryPicker({ id: 'kimi-cli-sessions', mode: 'read' });
      if (handle.name !== '.kimi-code') {
        throw new Error(t('目录选择错误：请选择 .kimi-code 文件夹。'));
      }
      await KimiCliUsage.saveDirectoryHandle(handle);
      await scanCliUsage(true);
    } catch (error) {
      await refreshCliStatus();
      if (!wasConnected && !cliConnected) setCliUi(false);
      if (error?.name !== 'AbortError') {
        showCliError(error?.message || t('连接失败，请重试'));
      }
    } finally {
      cliConnectBtn.disabled = false;
    }
  }

  cliConnectBtn.addEventListener('click', connectCliUsage);
  cliReauthBtn.addEventListener('click', connectCliUsage);
  cliDisconnectBtn.addEventListener('click', async () => {
    cliDisconnectBtn.disabled = true;
    try {
      await send('cli.usage.disconnect');
      showCliError();
      await refreshCliStatus();
    } catch (error) {
      showCliError(error?.message || t('断开失败，请重试'));
    } finally {
      cliDisconnectBtn.disabled = false;
    }
  });

