/**
 * 额度域：额度拉取（按账户单飞 + 30s 缓存）、月额度、每日快照、80%/95% 预警通知、
 * kimi.com 网页端 token 中转。依赖授权域的账户与 token。
 */

import * as KimiMetrics from '../metrics.js';
import { withStorageLock, updateStorage, failure, fetchWithTimeout } from './store.js';
import {
  readAccountStore,
  getValidTokenForAccount,
  refreshTokenSingleFlight,
  getAuthRevision,
  markAccountNeedsReauth,
  httpError
} from './oauth.js';

const QUOTA_API = 'https://api.kimi.com/coding/v1/usages';
// 订阅页月额度（方案 A：复用设备 OAuth token，401 时静默降级，见 requestMonthlyStats）
const SUBSCRIPTION_STATS_API = 'https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats';

const QUOTA_MONTHLY_STORAGE_KEY = 'quotaMonthlyLast';
// 三档额度每日快照（导出用），复用额度拉取，零额外请求
const QUOTA_SNAPSHOT_STORAGE_KEY = 'quotaSnapshots';
const QUOTA_SNAPSHOT_INTERVAL_MS = 6 * 3_600_000;
const QUOTA_SNAPSHOT_KEEP_DAYS = 90;
const QUOTA_ALERT_STORAGE_KEY = 'quotaAlertState';

const QUOTA_CACHE_TTL_MS = 30_000;

const quotaFetchPromises = new Map();
export const quotaCacheByAccount = new Map();

/* ---------- 额度预警 ----------
 * widget 每次拿到新鲜额度数据后顺带评估 5h / 本周两个窗口的占用百分比；
 * 越过 80% / 95% 各通知一次，窗口重置（百分比回落）后重新武装。
 * 预警状态按账户隔离，且本函数只由激活账户的额度拉取触发，
 * 非激活账户不会触发桌面通知。
 * 不做后台定时拉取，保持低功耗：没有 Kimi 标签页活动时不触发。 */
export async function evaluateQuotaAlerts(data, accountKey = 'default') {
  try {
    const percentages = extractQuotaPercentages(data);
    await updateStorage(QUOTA_ALERT_STORAGE_KEY, (stored) => {
      const state = stored && typeof stored === 'object' ? { ...stored } : {};
      const accountState =
        state[accountKey] && typeof state[accountKey] === 'object' ? { ...state[accountKey] } : {};
      let changed = false;
      for (const [key, pct] of Object.entries(percentages)) {
        if (pct == null) continue;
        const thresholdState =
          accountState[key] && typeof accountState[key] === 'object'
            ? { ...accountState[key] }
            : {};
        if (pct >= 95 && !thresholdState.notified95) {
          notifyQuotaThreshold(key, 95, pct);
          thresholdState.notified95 = true;
          thresholdState.notified80 = true;
          changed = true;
        } else if (pct >= 80 && !thresholdState.notified80) {
          notifyQuotaThreshold(key, 80, pct);
          thresholdState.notified80 = true;
          changed = true;
        }
        if (pct < 95 && thresholdState.notified95) {
          thresholdState.notified95 = false;
          changed = true;
        }
        if (pct < 80 && thresholdState.notified80) {
          thresholdState.notified80 = false;
          changed = true;
        }
        if (changed) {
          accountState[key] = thresholdState;
        }
      }
      if (!changed) return undefined;
      state[accountKey] = accountState;
      return state;
    });
  } catch (error) {
    console.warn('[Kimi Status] 额度预警评估失败', error);
  }
}

function extractQuotaPercentages(data) {
  // 与面板同一份推导逻辑（metrics.js quotaPercentage）。阈值判断使用原始值，
  // 避免 79.5% / 94.5% 因四舍五入而提前触发 80% / 95% 预警。
  const percentageOf = (detail) => KimiMetrics.quotaPercentage(detail);
  // duration 宽容解析为数字，API 返回字符串时不至于静默失效（与面板侧 toNumber 一致）
  const fiveHour = (data?.limits || []).find((entry) => Number(entry?.window?.duration) === 300);
  return { '5h': percentageOf(fiveHour?.detail), week: percentageOf(data?.usage) };
}

function notifyQuotaThreshold(key, level, pct) {
  const label = key === '5h' ? '5 小时额度' : '本周额度';
  const displayPct = KimiMetrics.formatPercentage(pct);
  chrome.notifications
    .create(`quota-${key}-${level}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: `Kimi ${label}已用 ${displayPct}%`,
      message:
        level >= 95
          ? '即将耗尽，点击打开控制台加油或调整用量'
          : '用量已超过 80%，点击打开控制台查看详情',
      priority: 1
    })
    .catch(() => {});
}

chrome.notifications.onClicked.addListener((notificationId) => {
  if (!notificationId.startsWith('quota-')) return;
  chrome.notifications.clear(notificationId);
  chrome.tabs.create({ url: 'https://www.kimi.com/code/console' });
});

/* ---------- kimi.com 网页端 token 中转（月额度接口方案 B） ----------
 * web-token.js 在 www.kimi.com 页面读取网页端 access_token 上报至此缓存；
 * GetSubscriptionStats 只认这个 web token（设备 OAuth token 401）。 */
const WEB_TOKEN_STORAGE_KEY = 'kimiWebAccessToken';
const WEB_TOKEN_REFRESH_MARGIN_SECONDS = 120;

export async function reportWebToken(payload) {
  const token = typeof payload?.token === 'string' ? payload.token : '';
  const expiresAt = Number(payload?.expiresAt);
  if (!token || !Number.isFinite(expiresAt) || expiresAt <= 0) {
    return { ok: false, error: 'token 无效' };
  }
  // 同一 token 不重复落盘，避免多标签页反复触发 storage 事件
  return withStorageLock(WEB_TOKEN_STORAGE_KEY, async () => {
    const stored = await chrome.storage.local.get(WEB_TOKEN_STORAGE_KEY);
    if (stored[WEB_TOKEN_STORAGE_KEY]?.token === token) return { ok: true, reused: true };
    await chrome.storage.local.set({
      [WEB_TOKEN_STORAGE_KEY]: { token, expiresAt, reportedAt: Date.now() }
    });
    return { ok: true };
  });
}

// 未过期才返回；过期即清除，等下次 kimi.com 页面访问补报
async function getStoredWebToken() {
  try {
    const stored = await chrome.storage.local.get(WEB_TOKEN_STORAGE_KEY);
    const entry = stored[WEB_TOKEN_STORAGE_KEY];
    if (!entry?.token || !Number.isFinite(entry?.expiresAt)) return null;
    const nowSeconds = Date.now() / 1_000;
    if (entry.expiresAt > nowSeconds + WEB_TOKEN_REFRESH_MARGIN_SECONDS) return entry.token;
    await chrome.storage.local.remove(WEB_TOKEN_STORAGE_KEY);
    return null;
  } catch (error) {
    console.warn('[Kimi Status] 读取 web token 缓存失败', error);
    return null;
  }
}

export async function fetchQuota(payload) {
  const store = await readAccountStore();
  const accountId = store.activeId || '';
  if (!payload?.force) {
    const cached = quotaCacheByAccount.get(accountId);
    if (cached) {
      // allowStale：切换账户后先展示该账户的旧缓存，调用方随后会强制刷新
      if (Date.now() - cached.fetchedAt < QUOTA_CACHE_TTL_MS || payload?.allowStale) {
        return cached.response;
      }
    }
  }
  const existing = quotaFetchPromises.get(accountId);
  if (existing) return existing;

  const promise = fetchQuotaFresh(accountId).finally(() => {
    quotaFetchPromises.delete(accountId);
  });
  quotaFetchPromises.set(accountId, promise);
  return promise;
}

export async function fetchQuotaFresh(accountId) {
  const requestRevision = getAuthRevision();
  const store = await readAccountStore();
  const resolvedAccountId = accountId || store.activeId;
  const account = store.accounts.find((item) => item.id === resolvedAccountId) || null;
  let token = await getValidTokenForAccount(account);
  if (!token) return failure(new Error('需要授权 Kimi 额度查询'), 'AUTH_REQUIRED');

  let response = await requestQuota(token.access_token);
  if (response.status === 401 || response.status === 403) {
    const rejectedAccessToken = token.access_token;
    token = await refreshTokenSingleFlight(account.id, token).catch(() => null);
    if (!token) {
      await markAccountNeedsReauth(account.id, rejectedAccessToken);
      return failure(new Error('Kimi 授权已失效'), 'AUTH_REQUIRED');
    }
    response = await requestQuota(token.access_token);
  }

  if (!response.ok) {
    // 刷新后仍 401/403：只标记该账户需重新授权，不拖垮其他账户
    if (response.status === 401 || response.status === 403) {
      await markAccountNeedsReauth(account.id, token.access_token);
      return failure(new Error('Kimi 授权已失效'), 'AUTH_REQUIRED');
    }
    throw await httpError('额度 API', response);
  }
  const data = await response.json();
  // 月额度暂时下线：web token 寿命仅约 18 分钟，中转/轮询方案体验不佳，
  // 找到更干净的通路前不再拉取（resolveMonthlyStats/requestMonthlyStats 保留备用）
  data.monthly = null;
  if (requestRevision !== getAuthRevision()) {
    return failure(new Error('授权状态已改变'), 'AUTH_REQUIRED');
  }
  // MV3 service worker 在消息响应结束后可能立即休眠；必须把预警状态与每日快照
  // 纳入当前消息任务生命周期，否则这两次 storage 写入会偶发丢失。
  await Promise.allSettled([
    evaluateQuotaAlerts(data, account.id),
    recordQuotaSnapshot(data)
  ]);
  const result = { ok: true, data };
  quotaCacheByAccount.set(account.id, { fetchedAt: Date.now(), response: result });
  return result;
}

// 月额度：实时成功则落盘最后已知值；失败回退该值（stale 标记），面板不再横杠
// 备用通路（当前 data.monthly 恒为 null，不调用）：导出为模块 API 备将来启用
export async function resolveMonthlyStats(deviceAccessToken) {
  const fresh = await requestMonthlyStats(deviceAccessToken);
  if (fresh) {
    const record = { ...fresh, fetchedAt: Date.now() };
    await chrome.storage.local.set({ [QUOTA_MONTHLY_STORAGE_KEY]: record }).catch(() => {});
    return record;
  }
  try {
    const stored = await chrome.storage.local.get(QUOTA_MONTHLY_STORAGE_KEY);
    const last = stored[QUOTA_MONTHLY_STORAGE_KEY];
    if (last && Number.isFinite(Number(last.usedRatio))) return { ...last, stale: true };
  } catch (error) {
    console.warn('[Kimi Status] 读取月额度缓存失败', error);
  }
  return null;
}

// 三档额度每日快照（每 6 小时最多一条）；失败静默，不影响主链路
export async function recordQuotaSnapshot(data) {
  try {
    const dayKey = KimiMetrics.usageDayKey(new Date());
    const percentages = extractQuotaPercentages(data);
    const monthRatio = Number(data?.monthly?.usedRatio);
    const stored = await chrome.storage.local.get(QUOTA_SNAPSHOT_STORAGE_KEY);
    const snapshots =
      stored[QUOTA_SNAPSHOT_STORAGE_KEY] && typeof stored[QUOTA_SNAPSHOT_STORAGE_KEY] === 'object'
        ? { ...stored[QUOTA_SNAPSHOT_STORAGE_KEY] }
        : {};
    const existing = snapshots[dayKey];
    if (existing && Date.now() - Number(existing.at || 0) < QUOTA_SNAPSHOT_INTERVAL_MS) return;
    snapshots[dayKey] = {
      '5h': percentages['5h'],
      week: percentages.week,
      month: Number.isFinite(monthRatio) ? Math.round(monthRatio * 1000) / 10 : null,
      at: Date.now()
    };
    // 与 CLI 长期用量同口径保留 90 天
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - (QUOTA_SNAPSHOT_KEEP_DAYS - 1));
    const cutoffKey = KimiMetrics.usageDayKey(cutoff);
    for (const key of Object.keys(snapshots)) {
      if (key < cutoffKey) delete snapshots[key];
    }
    await chrome.storage.local.set({ [QUOTA_SNAPSHOT_STORAGE_KEY]: snapshots });
  } catch (error) {
    console.warn('[Kimi Status] 额度快照失败', error);
  }
}

function requestQuota(accessToken) {
  return fetchWithTimeout(
    QUOTA_API,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    20_000
  );
}

// 月额度 = 订阅余额的已用比例 + 月度周期结束时间；任何失败都返回 null，不影响主额度
// 注意：重新启用此通路前，manifest 必须补 https://www.kimi.com/* 的 host_permissions
// （以及 web-token.js 的 content_scripts matches），否则 MV3 跨域 fetch 会被直接拒绝
async function requestMonthlyStats(deviceAccessToken) {
  // 优先 web 端 token（方案 B，已验证可用）；设备 token 兜底（当前 401，保留以便未来放开）
  const webToken = await getStoredWebToken();
  if (webToken) {
    const result = await callSubscriptionStats(webToken);
    if (result) return result;
    // web token 被拒（提前失效）：清掉缓存，等 kimi.com 页面下次补报
    await chrome.storage.local.remove(WEB_TOKEN_STORAGE_KEY).catch(() => {});
  }
  return callSubscriptionStats(deviceAccessToken);
}

// 返回 { usedRatio, resetTime, kimiCodeUsedRatio }；任何失败（含 401/403）返回 null
async function callSubscriptionStats(accessToken) {
  try {
    const response = await fetchWithTimeout(
      SUBSCRIPTION_STATS_API,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`
        },
        body: '{}'
      },
      15_000
    );
    if (!response.ok) return null;
    const stats = await response.json();
    const balance = stats?.subscriptionBalance;
    const usedRatio = Number(balance?.amountUsedRatio);
    const resetMs = Date.parse(balance?.expireTime || '');
    if (!Number.isFinite(usedRatio) || !Number.isFinite(resetMs)) return null;
    const kimiCodeUsedRatio = Number(balance?.kimiCodeUsedRatio);
    return {
      usedRatio,
      resetTime: balance.expireTime,
      kimiCodeUsedRatio: Number.isFinite(kimiCodeUsedRatio) ? kimiCodeUsedRatio : null
    };
  } catch (error) {
    console.warn('[Kimi Status] 月额度请求失败', error);
    return null;
  }
}


export async function clearAccountAlertState(accountId) {
  try {
    await updateStorage(QUOTA_ALERT_STORAGE_KEY, (state) => {
      if (!state || typeof state !== 'object' || !(accountId in state)) return undefined;
      const next = { ...state };
      delete next[accountId];
      return next;
    });
  } catch (error) {
    console.warn('[Kimi Status] 清理预警状态失败', error);
  }
}


// 授权域账户变更时使额度缓存失效（initOAuth 注入回调，避免额度域被反向依赖）
export function invalidateQuotaCache(accountId) {
  if (accountId == null) quotaCacheByAccount.clear();
  else quotaCacheByAccount.delete(accountId);
}
