/**
 * 长期统计域（CLI 按天汇总 + 外部账户）
 *
 * 职责边界：
 * - 读取 background 的 CLI 扫描状态与按天汇总缓存，写入 panel-state 并触发渲染。
 * - 轮次结束后的低频增量校准（防抖）。
 * - 外部账户（DeepSeek / Kimi API / 智谱 / MiniMax）的定时拉取。
 */

import * as KimiCliUsage from '../cli-usage.js';
import { panel } from './panel-state.js';
import { renderChart, renderAgents, renderPetStats, renderExternal } from './render.js';

const CLI_REFRESH_AFTER_TURN_MS = 1_500;
const CLI_REFRESH_STALE_MS = 60_000;

let cliRefreshTimer = null;

let deps = { isDisposed: () => false };

export function initUsageDaily(nextDeps) {
  deps = { ...deps, ...nextDeps };
}

export async function loadUsageDaily({ refreshIfStale = false } = {}) {
  if (deps.isDisposed()) return;
  try {
    const status = await chrome.runtime.sendMessage({ type: 'cli.usage.status' });
    panel.cliUsageConnected = status?.ok === true && status.connected === true;
    const stored = await chrome.storage.local.get([
      KimiCliUsage.DAILY_STORAGE_KEY,
      KimiCliUsage.HOURLY_STORAGE_KEY,
      KimiCliUsage.SECONDARY_MODEL_STORAGE_KEY
    ]);
    panel.secondaryModelName = stored[KimiCliUsage.SECONDARY_MODEL_STORAGE_KEY] || '';
    panel.usageDailyCache = panel.cliUsageConnected
      ? stored[KimiCliUsage.DAILY_STORAGE_KEY] || {}
      : {};
    panel.usageHourlyCache = panel.cliUsageConnected
      ? stored[KimiCliUsage.HOURLY_STORAGE_KEY] || {}
      : {};
    renderChart();
    renderAgents();
    renderPetStats();
    const lastScannedAt = Date.parse(status?.lastScannedAt || '');
    if (
      refreshIfStale &&
      panel.cliUsageConnected &&
      !status.scanning &&
      (!Number.isFinite(lastScannedAt) || Date.now() - lastScannedAt >= CLI_REFRESH_STALE_MS)
    ) {
      chrome.runtime.sendMessage({ type: 'cli.usage.refresh' }).catch(() => {});
    }
  } catch (error) {
    panel.cliUsageConnected = false;
    renderChart();
    renderPetStats();
  }
}

export function scheduleCliUsageRefresh() {
  if (!panel.cliUsageConnected) return;
  if (cliRefreshTimer) clearTimeout(cliRefreshTimer);
  // turn.ended 可能早于 wire 异步落盘；稍后只触发一次低频增量校准。
  cliRefreshTimer = setTimeout(() => {
    cliRefreshTimer = null;
    if (deps.isDisposed()) return;
    chrome.runtime.sendMessage({ type: 'cli.usage.refresh' }).catch(() => {});
  }, CLI_REFRESH_AFTER_TURN_MS);
}

export async function fetchExternalProviders() {
  if (deps.isDisposed() || panel.widgetConfig.modules.external?.show === 'hidden') return;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'external.status' });
    if (response?.ok) {
      panel.externalProviders = response.providers || [];
      renderExternal();
    }
  } catch (error) {
    console.warn('[Kimi Status] 读取外部账户失败', error);
  }
}

// dispose 时清理（content.js 调用）
export function disposeUsageDaily() {
  if (cliRefreshTimer) clearTimeout(cliRefreshTimer);
  cliRefreshTimer = null;
}
