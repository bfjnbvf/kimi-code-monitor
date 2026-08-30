/**
 * Kimi Code Monitor 后台 service worker（编排层）
 *
 * 职责边界：
 * - 消息路由、设备授权轮询 alarm、SW 启动恢复。
 * - 各域实现见 background/：store（存储锁/fetch/中转）、vault（密钥库）、
 *   oauth（授权与账户）、quota（额度/预警/快照）、external（外部 provider）、
 *   rename（会话命名）、pet（桌面宠物素材中转）、cli-scan（本地 CLI 扫描）。
 */
import { failure } from './background/store.js';
import {
  initOAuth,
  DEVICE_POLL_ALARM,
  runDevicePoll,
  loadPendingAuthorization,
  clearPendingAuthorization,
  scheduleDevicePoll,
  startOAuth,
  addAccountOAuth,
  reauthAccountOAuth,
  resetAndStartOAuth,
  switchAccount,
  removeAccount,
  renameAccount,
  authStatus,
  clearAuth
} from './background/oauth.js';
import { fetchQuota, reportWebToken, invalidateQuotaCache, clearAccountAlertState } from './background/quota.js';
import {
  getExternalProvidersStatus,
  addExternalAccount,
  removeExternalAccount,
  renameExternalAccount
} from './background/external.js';
import {
  renameModelCall,
  getRenameUsage,
  listRenameModels,
  listExternalRenameModels
} from './background/rename.js';
import { getActivePetAsset } from './background/pet.js';
import {
  getCliUsageStatus,
  refreshCliUsage,
  disconnectCliUsage,
  openCliUsageSettings,
  recoverInterruptedCliScan
} from './background/cli-scan.js';
import {
  listExtraWebHosts,
  grantExtraWebHost,
  revokeExtraWebHost,
  syncExtraWebHosts
} from './background/dynamic-hosts.js';

// 授权域不反向依赖额度域：账户变更时的额度缓存/预警清理由回调完成
initOAuth({
  invalidateQuotaCache,
  clearQuotaAlertState: clearAccountAlertState
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== DEVICE_POLL_ALARM) return;
  runDevicePoll();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handlers = {
    'quota.fetch': fetchQuota,
    'oauth.start': startOAuth,
    'oauth.add': addAccountOAuth,
    'oauth.reauth': reauthAccountOAuth,
    'oauth.reset': resetAndStartOAuth,
    'accounts.switch': switchAccount,
    'accounts.remove': removeAccount,
    'accounts.rename': renameAccount,
    'auth.status': authStatus,
    'auth.clear': clearAuth,
    'cli.usage.status': getCliUsageStatus,
    'cli.usage.refresh': refreshCliUsage,
    'cli.usage.disconnect': disconnectCliUsage,
    'cli.usage.open_settings': openCliUsageSettings,
    'webtoken.report': reportWebToken,
    'external.status': getExternalProvidersStatus,
    'external.add': addExternalAccount,
    'external.remove': removeExternalAccount,
    'external.rename': renameExternalAccount,
    'rename.model': renameModelCall,
    'rename.usage.get': getRenameUsage,
    'rename.models.list': listRenameModels,
    'rename.external.models.list': listExternalRenameModels,
    'pet.asset.active': getActivePetAsset,
    'hosts.list': listExtraWebHosts,
    'hosts.grant': (payload) => grantExtraWebHost(payload?.origin),
    'hosts.revoke': (payload) => revokeExtraWebHost(payload?.origin)
  };
  const handler = handlers[message?.type];
  if (!handler) return false;

  handler(message.payload)
    .then(sendResponse)
    .catch((error) => sendResponse(failure(error)));
  return true;
});

// 若 worker 在授权过程中被 Chrome 回收，下一次被唤醒时补建 alarm。
loadPendingAuthorization()
  .then(async (pending) => {
    if (!pending) return;
    if (Date.now() >= pending.expiresAt) {
      await clearPendingAuthorization({ closeTab: true });
      return;
    }
    const alarm = await chrome.alarms.get(DEVICE_POLL_ALARM);
    if (!alarm) await scheduleDevicePoll(pending.intervalMs);
  })
  .catch((error) => console.warn('[Kimi Status] 恢复授权轮询失败', error));

// SW 被回收后重启：若 storage 里还残留 scanning:true，说明上次扫描中断，标记为失败
recoverInterruptedCliScan();

// 安装/更新时对齐动态站点授权的内容脚本注册与 CSP 规则
chrome.runtime.onInstalled.addListener(() => {
  syncExtraWebHosts().catch((error) => console.warn('[Kimi Status] 同步动态站点授权失败', error));
});
