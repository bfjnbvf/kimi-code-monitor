importScripts('metrics.js');

const QUOTA_API = 'https://api.kimi.com/coding/v1/usages';
const AUTH_HOST = 'https://auth.kimi.com';
const DEVICE_AUTH_API = `${AUTH_HOST}/api/oauth/device_authorization`;
const TOKEN_API = `${AUTH_HOST}/api/oauth/token`;
const CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const TOKEN_STORAGE_KEY = 'kimiOAuthToken';
const DEVICE_ID_STORAGE_KEY = 'kimiDeviceId';
const PENDING_AUTH_STORAGE_KEY = 'kimiPendingAuthorization';
const USAGE_DAILY_STORAGE_KEY = 'usageDaily';
const USAGE_SEQ_STORAGE_KEY = 'usageSeq';
const USAGE_SEQ_MAX_SESSIONS = 50;
const QUOTA_ALERT_STORAGE_KEY = 'quotaAlertState';
const REFRESH_MARGIN_SECONDS = 300;
const DEVICE_POLL_ALARM = 'kimi-device-auth-poll';
const MIN_DEVICE_POLL_DELAY_MS = 30_000;
const QUOTA_CACHE_TTL_MS = 30_000;

let pendingAuthorization = null;
let devicePollTimer = null;
let devicePollPromise = null;
let oauthStartPromise = null;
let refreshPromise = null;
let quotaFetchPromise = null;
let quotaCache = null;
let authRevision = 0;

// worker 活着时用短定时器保持授权响应速度，alarm 负责休眠后的可靠恢复。
async function scheduleDevicePoll(delayMs) {
  if (devicePollTimer) clearTimeout(devicePollTimer);
  devicePollTimer = setTimeout(() => {
    devicePollTimer = null;
    runDevicePoll();
  }, delayMs);
  await chrome.alarms.create(DEVICE_POLL_ALARM, {
    when: Date.now() + Math.max(MIN_DEVICE_POLL_DELAY_MS, delayMs)
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== DEVICE_POLL_ALARM) return;
  runDevicePoll();
});

/* ---------- 额度预警 ----------
 * widget 每次拿到新鲜额度数据后顺带评估 5h / 本周两个窗口的占用百分比；
 * 越过 80% / 95% 各通知一次，窗口重置（百分比回落）后重新武装。
 * 不做后台定时拉取，保持低功耗：没有 Kimi 标签页活动时不触发。 */
async function evaluateQuotaAlerts(data) {
  try {
    const percentages = extractQuotaPercentages(data);
    const stored = await chrome.storage.local.get(QUOTA_ALERT_STORAGE_KEY);
    const state =
      stored[QUOTA_ALERT_STORAGE_KEY] && typeof stored[QUOTA_ALERT_STORAGE_KEY] === 'object'
        ? { ...stored[QUOTA_ALERT_STORAGE_KEY] }
        : {};
    let changed = false;
    for (const [key, pct] of Object.entries(percentages)) {
      if (pct == null) continue;
      const previousLevel = state[key]?.level || 0;
      const level = pct >= 95 ? 95 : pct >= 80 ? 80 : 0;
      if (level > previousLevel) notifyQuotaThreshold(key, level, pct);
      if (level !== previousLevel) {
        state[key] = { level };
        changed = true;
      }
    }
    if (changed) await chrome.storage.local.set({ [QUOTA_ALERT_STORAGE_KEY]: state });
  } catch (error) {
    console.warn('[Kimi Status] 额度预警评估失败', error);
  }
}

function extractQuotaPercentages(data) {
  // used 可能缺省，此时用 limit - remaining 推导（与 KimiCodeBar 口径一致）
  const percentageOf = (detail) => {
    const limit = Number(detail?.limit);
    if (!Number.isFinite(limit) || limit <= 0) return null;
    const used = Number(detail?.used);
    if (Number.isFinite(used) && used >= 0) return Math.round((used / limit) * 100);
    const remaining = Number(detail?.remaining);
    if (Number.isFinite(remaining)) return Math.round(((limit - remaining) / limit) * 100);
    return null;
  };
  const fiveHour = (data?.limits || []).find((entry) => entry?.window?.duration === 300);
  return { '5h': percentageOf(fiveHour?.detail), week: percentageOf(data?.usage) };
}

function notifyQuotaThreshold(key, level, pct) {
  const label = key === '5h' ? '5 小时额度' : '本周额度';
  chrome.notifications
    .create(`quota-${key}-${level}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: `Kimi ${label}已用 ${pct}%`,
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

function runDevicePoll() {
  if (devicePollPromise) return devicePollPromise;
  devicePollPromise = (async () => {
    try {
      await pollDeviceAuthorization();
    } catch (error) {
      console.warn('[Kimi Status] 授权轮询失败，将自动重试', error);
      const pending = await loadPendingAuthorization();
      if (pending && Date.now() < pending.expiresAt) {
        await scheduleDevicePoll(pending.intervalMs);
      }
    }
  })().finally(() => {
    devicePollPromise = null;
  });
  return devicePollPromise;
}

async function loadPendingAuthorization() {
  if (pendingAuthorization) return pendingAuthorization;
  const stored = await chrome.storage.session.get(PENDING_AUTH_STORAGE_KEY);
  pendingAuthorization = stored[PENDING_AUTH_STORAGE_KEY] || null;
  return pendingAuthorization;
}

async function pollDeviceAuthorization() {
  await loadPendingAuthorization();
  if (!pendingAuthorization) return;
  if (Date.now() >= pendingAuthorization.expiresAt) {
    await clearPendingAuthorization({ closeTab: true });
    return;
  }
  const authorization = pendingAuthorization;
  const pollRevision = authRevision;

  const response = await postForm(TOKEN_API, {
    client_id: CLIENT_ID,
    device_code: authorization.deviceCode,
    grant_type: DEVICE_GRANT_TYPE
  });
  const data = await response.json().catch(() => ({}));
  if (
    pollRevision !== authRevision ||
    pendingAuthorization?.deviceCode !== authorization.deviceCode
  ) return;

  if (!response.ok) {
    if (data.error === 'authorization_pending') {
      await scheduleDevicePoll(authorization.intervalMs);
      return;
    }
    if (data.error === 'slow_down') {
      authorization.intervalMs += 5_000;
      await chrome.storage.session.set({ [PENDING_AUTH_STORAGE_KEY]: authorization });
      await scheduleDevicePoll(authorization.intervalMs);
      return;
    }
    await clearPendingAuthorization({ closeTab: true });
    console.warn('[Kimi Status] 设备授权失败', data);
    return;
  }

  const token = normalizeToken(data);
  await chrome.storage.local.set({ [TOKEN_STORAGE_KEY]: token });
  quotaCache = null;
  const authTabId = await clearPendingAuthorization();
  // 授权成功后自动关掉我们打开的授权页
  if (authTabId != null) {
    chrome.tabs.remove(authTabId).catch(() => {});
  }
  broadcastAuthState('auth.completed');
}

// 通知所有 Kimi Code Web 页面：授权已完成，立即刷新额度
function broadcastAuthState(type) {
  chrome.tabs
    .query({ url: ['http://127.0.0.1/*', 'http://localhost/*'] })
    .then((tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { type }).catch(() => {});
      }
    })
    .catch(() => {});
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handlers = {
    'quota.fetch': fetchQuota,
    'oauth.start': startOAuth,
    'oauth.reset': resetAndStartOAuth,
    'auth.status': authStatus,
    'auth.clear': clearAuth,
    'usage.record': enqueueRecordUsage
  };
  const handler = handlers[message?.type];
  if (!handler) return false;

  handler(message.payload)
    .then(sendResponse)
    .catch((error) => sendResponse(failure(error)));
  return true;
});

/* ---------- 按天消耗量累计 ----------
 * content.js 在每个 turn.step.completed 事件上报一次该 step 的 usage。
 * 同一会话可能在多个标签页打开，这里按 sessionId 记录已累计的最大 seq 去重；
 * 桶结构见 metrics.js accumulateDailyUsage。 */
let usageWriteQueue = Promise.resolve();

// 读-改-写不是原子的，多个标签页同时上报会互相覆盖；串行化所有写入
function enqueueRecordUsage(payload) {
  usageWriteQueue = usageWriteQueue
    .catch(() => {})
    .then(() => recordUsage(payload));
  return usageWriteQueue;
}

async function recordUsage(payload) {
  const sessionId = String(payload?.sessionId || '');
  const seq = Number(payload?.seq);
  const usage = payload?.usage;
  const dayKey = String(payload?.dayKey || '');
  if (
    !sessionId ||
    !Number.isFinite(seq) ||
    !usage ||
    !/^\d{4}-\d{2}-\d{2}$/.test(dayKey)
  ) {
    return failure(new Error('用量记录参数无效'), 'INVALID_USAGE_RECORD');
  }

  const stored = await chrome.storage.local.get([
    USAGE_DAILY_STORAGE_KEY,
    USAGE_SEQ_STORAGE_KEY
  ]);
  const seqMap =
    stored[USAGE_SEQ_STORAGE_KEY] && typeof stored[USAGE_SEQ_STORAGE_KEY] === 'object'
      ? { ...stored[USAGE_SEQ_STORAGE_KEY] }
      : {};
  if ((seqMap[sessionId] ?? -1) >= seq) return { ok: true, deduped: true };

  let daily = KimiMetrics.accumulateDailyUsage(
    stored[USAGE_DAILY_STORAGE_KEY],
    dayKey,
    usage,
    payload.subagent === true
  );
  daily = KimiMetrics.pruneDailyUsage(daily);
  seqMap[sessionId] = seq;
  // 会话键只增不减，超出上限时按插入顺序裁掉最旧的
  const sessionKeys = Object.keys(seqMap);
  if (sessionKeys.length > USAGE_SEQ_MAX_SESSIONS) {
    for (const key of sessionKeys.slice(0, sessionKeys.length - USAGE_SEQ_MAX_SESSIONS)) {
      delete seqMap[key];
    }
  }
  await chrome.storage.local.set({
    [USAGE_DAILY_STORAGE_KEY]: daily,
    [USAGE_SEQ_STORAGE_KEY]: seqMap
  });
  return { ok: true };
}

function failure(error, code = 'REQUEST_FAILED') {
  return { ok: false, code, error: error?.message || String(error) };
}

async function fetchQuota() {
  if (quotaCache && Date.now() - quotaCache.fetchedAt < QUOTA_CACHE_TTL_MS) {
    return quotaCache.response;
  }
  if (quotaFetchPromise) return quotaFetchPromise;

  quotaFetchPromise = fetchQuotaFresh().finally(() => {
    quotaFetchPromise = null;
  });
  return quotaFetchPromise;
}

async function fetchQuotaFresh() {
  const requestRevision = authRevision;
  let token = await getValidToken();
  if (!token) return failure(new Error('需要授权 Kimi 额度查询'), 'AUTH_REQUIRED');

  let response = await requestQuota(token.access_token);
  if (response.status === 401 || response.status === 403) {
    const rejectedAccessToken = token.access_token;
    token = await refreshTokenSingleFlight(token).catch(() => null);
    if (!token) {
      await clearStoredTokenIfMatches(rejectedAccessToken);
      return failure(new Error('Kimi 授权已失效'), 'AUTH_REQUIRED');
    }
    response = await requestQuota(token.access_token);
  }

  if (!response.ok) throw await httpError('额度 API', response);
  const data = await response.json();
  if (requestRevision !== authRevision) {
    return failure(new Error('授权状态已改变'), 'AUTH_REQUIRED');
  }
  // 额度预警评估不阻塞响应
  evaluateQuotaAlerts(data);
  const result = { ok: true, data };
  quotaCache = { fetchedAt: Date.now(), response: result };
  return result;
}

function requestQuota(accessToken) {
  return fetch(QUOTA_API, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(20_000)
  });
}

async function getValidToken() {
  const stored = await chrome.storage.local.get(TOKEN_STORAGE_KEY);
  const token = stored[TOKEN_STORAGE_KEY];
  if (!isTokenShapeValid(token)) return null;

  const now = Math.floor(Date.now() / 1_000);
  if (token.expires_at > now + REFRESH_MARGIN_SECONDS) return token;
  return refreshTokenSingleFlight(token).catch(() => null);
}

function isTokenShapeValid(token) {
  return Boolean(
    token &&
    typeof token.access_token === 'string' && token.access_token &&
    typeof token.refresh_token === 'string' && token.refresh_token &&
    Number.isFinite(token.expires_at)
  );
}

function startOAuth() {
  if (oauthStartPromise) return oauthStartPromise;
  oauthStartPromise = startOAuthInternal().finally(() => {
    oauthStartPromise = null;
  });
  return oauthStartPromise;
}

async function startOAuthInternal() {
  const startRevision = authRevision;
  const existing = await loadPendingAuthorization();
  if (existing && Date.now() < existing.expiresAt) {
    await ensureAuthorizationTab(existing, startRevision);
    if (startRevision !== authRevision) throw new Error('授权已被取消');
    const alarm = await chrome.alarms.get(DEVICE_POLL_ALARM);
    if (!alarm) await scheduleDevicePoll(existing.intervalMs);
    return {
      ok: true,
      pending: true,
      userCode: existing.userCode,
      intervalMs: existing.intervalMs
    };
  }
  if (existing) await clearPendingAuthorization({ closeTab: true });

  const response = await postForm(DEVICE_AUTH_API, { client_id: CLIENT_ID });
  if (!response.ok) throw await httpError('设备授权', response);
  const data = await response.json();
  if (startRevision !== authRevision) throw new Error('授权已被取消');
  if (!data.device_code || !data.user_code) throw new Error('设备授权响应不完整');

  const expiresIn = Number(data.expires_in) || 900;
  pendingAuthorization = {
    deviceCode: data.device_code,
    userCode: data.user_code,
    expiresAt: Date.now() + expiresIn * 1_000,
    intervalMs: Math.max(2_000, (Number(data.interval) || 5) * 1_000),
    tabId: null,
    authorizationUrl: data.verification_uri_complete || data.verification_uri || ''
  };
  const userCode = pendingAuthorization.userCode;
  const intervalMs = pendingAuthorization.intervalMs;

  const authorization = pendingAuthorization;
  await ensureAuthorizationTab(authorization, startRevision);
  if (startRevision !== authRevision) {
    const tabId = authorization.tabId;
    if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    throw new Error('授权已被取消');
  }
  await chrome.storage.session.set({ [PENDING_AUTH_STORAGE_KEY]: pendingAuthorization });

  // 在当前消息事件内完成第一次轮询，之后交给可恢复的 alarm。
  await pollDeviceAuthorization();

  return {
    ok: true,
    userCode,
    intervalMs
  };
}

async function ensureAuthorizationTab(authorization, expectedRevision) {
  if (!authorization?.authorizationUrl) return;
  if (authorization.tabId != null) {
    try {
      await chrome.tabs.update(authorization.tabId, { active: true });
      return;
    } catch (error) {
      authorization.tabId = null;
    }
  }
  const tab = await chrome.tabs.create({ url: authorization.authorizationUrl });
  if (expectedRevision !== authRevision) {
    if (tab?.id != null) chrome.tabs.remove(tab.id).catch(() => {});
    throw new Error('授权已被取消');
  }
  authorization.tabId = tab?.id ?? null;
  await chrome.storage.session.set({ [PENDING_AUTH_STORAGE_KEY]: authorization });
}

// 供扩展弹窗查询当前授权状态
async function authStatus() {
  await loadPendingAuthorization();
  if (pendingAuthorization && Date.now() >= pendingAuthorization.expiresAt) {
    await clearPendingAuthorization({ closeTab: true });
  }
  const stored = await chrome.storage.local.get(TOKEN_STORAGE_KEY);
  const token = stored[TOKEN_STORAGE_KEY];
  if (!isTokenShapeValid(token)) {
    return {
      ok: true,
      authorized: false,
      pending: Boolean(pendingAuthorization),
      userCode: pendingAuthorization?.userCode || ''
    };
  }
  return {
    ok: true,
    authorized: true,
    expiresAt: token.expires_at * 1_000
  };
}

// 重新授权 / 切换账户：清掉现有 token 后走完整设备授权流程
async function resetAndStartOAuth() {
  await clearAuth();
  return startOAuth();
}

// 仅清除授权（测试或换账户前的重置）
async function clearAuth() {
  authRevision += 1;
  await chrome.storage.local.remove(TOKEN_STORAGE_KEY);
  await clearPendingAuthorization({ closeTab: true });
  quotaCache = null;
  // 通知内容脚本重新显示新手引导
  await chrome.storage.local.set({ kimiOnboardingResetAt: Date.now() });
  broadcastAuthState('auth.cleared');
  return { ok: true };
}

async function clearPendingAuthorization({ closeTab = false } = {}) {
  const pending = pendingAuthorization || await loadPendingAuthorization();
  const tabId = pending?.tabId ?? null;
  pendingAuthorization = null;
  if (devicePollTimer) clearTimeout(devicePollTimer);
  devicePollTimer = null;
  await chrome.alarms.clear(DEVICE_POLL_ALARM);
  await chrome.storage.session.remove(PENDING_AUTH_STORAGE_KEY);
  if (closeTab && tabId != null) {
    chrome.tabs.remove(tabId).catch(() => {});
  }
  return tabId;
}

function refreshTokenSingleFlight(token) {
  if (refreshPromise) return refreshPromise;
  refreshPromise = refreshToken(token).finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

async function refreshToken(token) {
  const refreshRevision = authRevision;
  const response = await postForm(TOKEN_API, {
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: token.refresh_token
  });
  if (!response.ok) throw await httpError('Kimi token 刷新', response);
  const data = await response.json();
  if (refreshRevision !== authRevision) throw new Error('授权状态已改变');

  const refreshed = normalizeToken(data, token.refresh_token);
  await chrome.storage.local.set({ [TOKEN_STORAGE_KEY]: refreshed });
  return refreshed;
}

async function clearStoredTokenIfMatches(accessToken) {
  const stored = await chrome.storage.local.get(TOKEN_STORAGE_KEY);
  if (stored[TOKEN_STORAGE_KEY]?.access_token === accessToken) {
    await chrome.storage.local.remove(TOKEN_STORAGE_KEY);
    quotaCache = null;
  }
}

function normalizeToken(data, fallbackRefreshToken = '') {
  const expiresIn = Number(data.expires_in);
  const refreshTokenValue = data.refresh_token || fallbackRefreshToken;
  if (!data.access_token || !refreshTokenValue || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error('Kimi token 响应不完整');
  }
  return {
    access_token: data.access_token,
    refresh_token: refreshTokenValue,
    expires_at: Math.floor(Date.now() / 1_000) + expiresIn,
    expires_in: expiresIn,
    scope: data.scope || '',
    token_type: data.token_type || 'bearer'
  };
}

async function postForm(url, parameters) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      ...(await identityHeaders())
    },
    body: new URLSearchParams(parameters).toString(),
    signal: AbortSignal.timeout(20_000)
  });
}

async function identityHeaders() {
  const stored = await chrome.storage.local.get(DEVICE_ID_STORAGE_KEY);
  let deviceId = stored[DEVICE_ID_STORAGE_KEY];
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    await chrome.storage.local.set({ [DEVICE_ID_STORAGE_KEY]: deviceId });
  }
  return {
    'X-Msh-Platform': 'kimi_code_cli',
    'X-Msh-Version': chrome.runtime.getManifest().version,
    'X-Msh-Device-Id': deviceId,
    'X-Msh-Device-Name': 'Chrome Extension',
    'X-Msh-Device-Model': navigator.userAgent,
    'X-Msh-Os-Version': navigator.platform || 'unknown'
  };
}

async function httpError(label, response) {
  const data = await response.json().catch(() => ({}));
  const detail = data?.error?.message || data?.error_description || data?.message || data?.error;
  return new Error(`${label} HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
}

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
