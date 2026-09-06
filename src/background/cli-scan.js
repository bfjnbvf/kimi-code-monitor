/**
 * CLI 扫描域：本地 sessions 目录的增量扫描调度、状态持久化、SW 重启恢复。
 * 目录句柄只由 popup/options 的用户手势写入 IndexedDB，这里只读取。
 */

import * as KimiCliUsage from '../cli-usage.js';
import { withStorageLock, updateStorage, failure } from './store.js';
import { queryKimiWebTabs } from './dynamic-hosts.js';

/* ---------- 本地 Kimi CLI 长期用量 ----------
 * 目录选择必须在 popup/options 的用户点击中完成；后台只读取已存入 IndexedDB
 * 的 sessions 目录句柄。CLI 文件是长期统计的权威来源，WebSocket 不与它相加。 */
let cliUsageScanPromise = null;
let cliUsageScanProgress = 0;
const CLI_AUTO_REFRESH_COOLDOWN_MS = 15_000;

export async function getCliUsageStatus() {
  const handle = await KimiCliUsage.getDirectoryHandle().catch(() => null);
  const permission = await KimiCliUsage.permissionState(handle);
  const stored = await chrome.storage.local.get(KimiCliUsage.STATE_STORAGE_KEY);
  const state = stored[KimiCliUsage.STATE_STORAGE_KEY] || {};
  return {
    ok: true,
    connected: Boolean(handle) && permission === 'granted',
    permission,
    directoryName: handle?.name || state.directoryName || '',
    // MV3：以 chrome.storage 中的 scanning 为准，SW 回收后也能正确反映状态。
    scanning: Boolean(state.scanning),
    progress: cliUsageScanPromise != null ? cliUsageScanProgress : null,
    lastScannedAt: state.lastScannedAt || null,
    fileCount: Number(state.fileCount) || 0,
    error: state.error || ''
  };
}

export async function refreshCliUsage(options = {}) {
  if (cliUsageScanPromise) return cliUsageScanPromise;
  if (options?.force !== true) {
    const stored = await chrome.storage.local.get(KimiCliUsage.STATE_STORAGE_KEY);
    const lastScannedAt = Date.parse(stored[KimiCliUsage.STATE_STORAGE_KEY]?.lastScannedAt || '');
    if (Number.isFinite(lastScannedAt) && Date.now() - lastScannedAt < CLI_AUTO_REFRESH_COOLDOWN_MS) {
      return { ok: true, skipped: true, reason: 'cooldown' };
    }
  }
  cliUsageScanProgress = 0;
  cliUsageScanPromise = (async () => {
    const handle = await KimiCliUsage.getDirectoryHandle().catch(() => null);
    if (!handle) return failure(new Error('尚未连接本地 Kimi CLI'), 'CLI_NOT_CONNECTED');
    const permission = await KimiCliUsage.permissionState(handle);
    if (permission !== 'granted') {
      return failure(new Error('需要重新授权本地 sessions 目录'), 'CLI_PERMISSION_REQUIRED');
    }

    const startedState = {
      connected: true,
      scanning: true,
      directoryName: handle.name,
      lastScannedAt: null,
      error: ''
    };
    const before = await chrome.storage.local.get([
      KimiCliUsage.INDEX_STORAGE_KEY,
      KimiCliUsage.STATE_STORAGE_KEY
    ]);
    startedState.lastScannedAt = before[KimiCliUsage.STATE_STORAGE_KEY]?.lastScannedAt || null;
    await updateStorage(KimiCliUsage.STATE_STORAGE_KEY, () => startedState);

    try {
      const result = await KimiCliUsage.scanSessionsDirectory(
        handle,
        before[KimiCliUsage.INDEX_STORAGE_KEY],
        (progress) => {
          cliUsageScanProgress = progress;
        }
      );
      const state = {
        connected: true,
        scanning: false,
        directoryName: handle.name,
        lastScannedAt: result.scannedAt,
        fileCount: result.fileCount,
        changedFiles: result.changedFiles,
        skippedFiles: result.skippedFiles || 0,
        // 部分文件读取失败（网络盘断连等）时透出首个错误，不再显示泛化文案
        error: result.firstError || ''
      };
      await withStorageLock(KimiCliUsage.STATE_STORAGE_KEY, async () => {
        await chrome.storage.local.set({
          [KimiCliUsage.DAILY_STORAGE_KEY]: result.daily,
          [KimiCliUsage.HOURLY_STORAGE_KEY]: result.hourly,
          [KimiCliUsage.INDEX_STORAGE_KEY]: result.index,
          [KimiCliUsage.SESSIONS_STORAGE_KEY]: result.sessions,
          [KimiCliUsage.STATE_STORAGE_KEY]: state
        });
        // 授权了 .kimi-code 根目录时才有：次级模型（子代理）的真实模型名
        if (result.secondaryModel) {
          await chrome.storage.local.set({
            [KimiCliUsage.SECONDARY_MODEL_STORAGE_KEY]: result.secondaryModel
          });
        }
      });
      broadcastCliUsageState('cli.usage.updated');
      return { ok: true, ...state };
    } catch (error) {
      // 失败时保留前次成功扫描的 fileCount，避免 UI 显示归零造成数据清空的错觉
      const previous = before[KimiCliUsage.STATE_STORAGE_KEY] || {};
      const state = {
        connected: true,
        scanning: false,
        directoryName: handle.name,
        lastScannedAt: startedState.lastScannedAt,
        fileCount: Number(previous.fileCount) || 0,
        changedFiles: 0,
        error: error?.message || String(error)
      };
      await updateStorage(KimiCliUsage.STATE_STORAGE_KEY, () => state);
      return failure(error, 'CLI_SCAN_FAILED');
    }
  })().finally(() => {
    cliUsageScanPromise = null;
  });
  return cliUsageScanPromise;
}

export async function disconnectCliUsage() {
  // 先等待进行中的扫描写完，避免断开后被扫描结果“复活”为已连接
  if (cliUsageScanPromise) await cliUsageScanPromise.catch(() => {});
  await KimiCliUsage.clearDirectoryHandle().catch(() => {});
  await chrome.storage.local.remove([
    KimiCliUsage.DAILY_STORAGE_KEY,
    KimiCliUsage.HOURLY_STORAGE_KEY,
    KimiCliUsage.INDEX_STORAGE_KEY,
    KimiCliUsage.SESSIONS_STORAGE_KEY,
    KimiCliUsage.STATE_STORAGE_KEY
  ]);
  broadcastCliUsageState('cli.usage.disconnected');
  return { ok: true };
}

export async function openCliUsageSettings() {
  await chrome.runtime.openOptionsPage();
  return { ok: true };
}

function broadcastCliUsageState(type) {
  queryKimiWebTabs().then((tabs) => {
    for (const tab of tabs) chrome.tabs.sendMessage(tab.id, { type }).catch(() => {});
  });
}


// SW 被回收后重启：若 storage 里还残留 scanning:true，说明上次扫描中断，
// 将其标记为失败，避免 UI 永久卡在扫描中。
export async function recoverInterruptedCliScan() {
  try {
    const stored = await chrome.storage.local.get(KimiCliUsage.STATE_STORAGE_KEY);
    const state = stored[KimiCliUsage.STATE_STORAGE_KEY];
    if (state && state.scanning) {
      await chrome.storage.local.set({
        [KimiCliUsage.STATE_STORAGE_KEY]: {
          ...state,
          scanning: false,
          error: '上次扫描被浏览器中断，请手动刷新'
        }
      });
    }
  } catch (error) {
    // 启动恢复失败静默
  }
}
