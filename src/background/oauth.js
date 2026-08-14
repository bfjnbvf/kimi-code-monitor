/**
 * 授权域：Kimi 设备授权流、多账户存储与 token 生命周期（含加密落盘、单飞刷新）。
 * 额度缓存/预警的失效经 initOAuth 注入的回调完成，不反向依赖额度域。
 */

import { withStorageLock, updateStorage, failure, fetchWithTimeout } from './store.js';
import { encryptSecret, decryptSecret } from './vault.js';

// 额度域注入的失效回调（账户变更时清理额度缓存与预警状态）
let hooks = {
  invalidateQuotaCache: () => {},
  clearQuotaAlertState: async () => {}
};

export function initOAuth(nextHooks) {
  hooks = { ...hooks, ...nextHooks };
}

const AUTH_HOST = 'https://auth.kimi.com';
const DEVICE_AUTH_API = `${AUTH_HOST}/api/oauth/device_authorization`;
const TOKEN_API = `${AUTH_HOST}/api/oauth/token`;
const CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const TOKEN_STORAGE_KEY = 'kimiOAuthToken'; // 旧版单 token 键，仅用于迁移
// 多账户额度授权：{ accounts: [{ id, label, token, needsReauth, addedAt }], activeId }
const ACCOUNTS_STORAGE_KEY = 'kimiOAuthAccounts';
const DEVICE_ID_STORAGE_KEY = 'kimiDeviceId';
const PENDING_AUTH_STORAGE_KEY = 'kimiPendingAuthorization';

const REFRESH_MARGIN_SECONDS = 300;
export const DEVICE_POLL_ALARM = 'kimi-device-auth-poll';
const MIN_DEVICE_POLL_DELAY_MS = 30_000;

let pendingAuthorization = null;
let devicePollTimer = null;
let devicePollPromise = null;
let oauthStartPromise = null;
// token 刷新单飞与额度缓存都按账户 id 隔离：多账户切换互不影响
const refreshPromises = new Map();

let authRevision = 0;

// 授权代际：授权流/额度拉取用它在 await 前后侦测「期间发生过账户变更」
export function getAuthRevision() {
  return authRevision;
}

export async function scheduleDevicePoll(delayMs) {
  if (devicePollTimer) clearTimeout(devicePollTimer);
  devicePollTimer = setTimeout(() => {
    devicePollTimer = null;
    runDevicePoll();
  }, delayMs);
  await chrome.alarms.create(DEVICE_POLL_ALARM, {
    when: Date.now() + Math.max(MIN_DEVICE_POLL_DELAY_MS, delayMs)
  });
}


export function runDevicePoll() {
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

export async function loadPendingAuthorization() {
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
  const account = await completeAccountAuthorization(authorization, token);
  hooks.invalidateQuotaCache(account.id);
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


/* ---------- 多账户存储 ----------
 * chrome.storage.local 的 kimiOAuthAccounts：
 * { accounts: [{ id, label, token, needsReauth, addedAt }], activeId }
 * token 结构与旧版单账户一致；needsReauth 标记刷新后仍 401 的失效账户，
 * 失效账户保留在列表里等重新授权，不影响其他账户。 */
function newAccountId() {
  return `kimi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function nextDefaultLabel(accounts) {
  const used = new Set(accounts.map((account) => account.label));
  let index = 1;
  while (used.has(`账户 ${index}`)) index += 1;
  return `账户 ${index}`;
}

export function activeAccountOf(store) {
  return store.accounts.find((account) => account.id === store.activeId) || null;
}

async function encryptAccountToken(token) {
  return encryptSecret(JSON.stringify(token));
}

async function decryptAccountToken(record) {
  const plain = await decryptSecret(record);
  return JSON.parse(plain);
}

async function persistAccountStore(store) {
  const persisted = JSON.parse(JSON.stringify(store));
  for (const account of persisted.accounts) {
    if (account.token) {
      account.tokenEnc = await encryptAccountToken(account.token);
      delete account.token;
    }
  }
  await chrome.storage.local.set({ [ACCOUNTS_STORAGE_KEY]: persisted });
}

async function writeAccountStore(store) {
  await withStorageLock(ACCOUNTS_STORAGE_KEY, async () => {
    await persistAccountStore(store);
  });
}

// 读取账户表；检测到旧版单 token 存储时迁移为首个账户（默认「账户 1」）并删除旧键。
// 已持久化的 token 是密文（tokenEnc），读入时解密为内存对象 token；写入时再由
// persistAccountStore 加密回 tokenEnc，实现透明迁移。
export async function readAccountStore() {
  const stored = await chrome.storage.local.get([ACCOUNTS_STORAGE_KEY, TOKEN_STORAGE_KEY]);
  const raw = stored[ACCOUNTS_STORAGE_KEY];
  let store;
  let dirty = false;
  if (raw && typeof raw === 'object' && Array.isArray(raw.accounts)) {
    const accounts = [];
    for (const account of raw.accounts) {
      if (!account || typeof account.id !== 'string') {
        dirty = true;
        continue;
      }
      const copy = { ...account };
      const hadTokenEnc = Boolean(copy.tokenEnc);
      if (copy.tokenEnc && !copy.token) {
        try {
          copy.token = await decryptAccountToken(copy.tokenEnc);
        } catch {
          copy.token = null;
        }
        delete copy.tokenEnc;
      }
      // 只有 storage 里原本是明文 token（无 tokenEnc）才需要触发加密迁移；
      // 解密已加密 token 是读侧规范化，不应产生写回，避免与并发更新竞态。
      if (copy.token && !hadTokenEnc) dirty = true;
      accounts.push(copy);
    }
    dirty = dirty || accounts.length !== raw.accounts.length;
    store = { accounts, activeId: typeof raw.activeId === 'string' ? raw.activeId : null };
  } else {
    store = { accounts: [], activeId: null };
    dirty = raw != null;
  }
  const legacy = stored[TOKEN_STORAGE_KEY];
  if (legacy) {
    if (isTokenShapeValid(legacy)) {
      const account = {
        id: newAccountId(),
        label: nextDefaultLabel(store.accounts),
        token: legacy,
        needsReauth: false,
        addedAt: Date.now()
      };
      store.accounts.push(account);
      if (!store.activeId) store.activeId = account.id;
    }
    dirty = true;
  }
  // activeId 失效（账户被移除等）时回落到剩余第一个，无剩余则为 null
  if (!store.accounts.some((account) => account.id === store.activeId)) {
    const fallback = store.accounts[0]?.id || null;
    if (store.activeId !== fallback) {
      store.activeId = fallback;
      dirty = true;
    }
  }
  if (dirty) {
    await chrome.storage.local.remove(TOKEN_STORAGE_KEY);
    await writeAccountStore(store);
  }
  return store;
}

// 授权完成：accountId 命中的为重新授权（保留备注名），否则新建账户；
// 最新完成授权的账户一律成为当前激活账户
async function completeAccountAuthorization(authorization, token) {
  const store = await readAccountStore();
  const target = store.accounts.find((account) => account.id === authorization.accountId);
  if (target) {
    target.token = token;
    target.needsReauth = false;
    store.activeId = target.id;
    await writeAccountStore(store);
    return target;
  }
  const account = {
    id: newAccountId(),
    label: authorization.label || nextDefaultLabel(store.accounts),
    token,
    needsReauth: false,
    addedAt: Date.now()
  };
  store.accounts.push(account);
  store.activeId = account.id;
  await writeAccountStore(store);
  return account;
}

// 在加锁状态下读取最新账户表，定位 accountId 并应用 updater，写回时自动加密 token。
// updater 接收内存形态的 account 对象（含明文 token），可原地修改；返回 false 表示放弃写回。
async function updateAccountInStore(accountId, updater) {
  return updateStorage(ACCOUNTS_STORAGE_KEY, async (raw) => {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.accounts)) return undefined;
    const accounts = [];
    let changed = false;
    let found = false;
    for (const account of raw.accounts) {
      if (!account || typeof account.id !== 'string') {
        changed = true;
        continue;
      }
      if (account.id !== accountId) {
        accounts.push(account);
        continue;
      }
      found = true;
      const copy = { ...account };
      if (copy.tokenEnc && !copy.token) {
        try {
          copy.token = await decryptAccountToken(copy.tokenEnc);
        } catch {
          copy.token = null;
        }
        delete copy.tokenEnc;
      }
      const keep = await updater(copy);
      if (keep === false) return undefined;
      if (copy.token) {
        copy.tokenEnc = await encryptAccountToken(copy.token);
        delete copy.token;
      }
      accounts.push(copy);
      changed = true;
    }
    if (!found || !changed) return undefined;
    return { ...raw, accounts };
  });
}

// token 失效（刷新后仍 401）：清空该账户 token 并标记需重新授权；
// accessToken 不匹配说明已被并发流程换新，不动它
export async function markAccountNeedsReauth(accountId, accessToken) {
  await updateAccountInStore(accountId, (account) => {
    if (!account) return false;
    if (accessToken && account.token && account.token.access_token !== accessToken) return false;
    account.token = null;
    account.needsReauth = true;
  });
  hooks.invalidateQuotaCache(accountId);
}

// options：accountId 重新授权指定账户；forceNew 强制新建账户；label 新账户备注名
export function startOAuth(options = {}) {
  if (oauthStartPromise) return oauthStartPromise;
  oauthStartPromise = startOAuthInternal(options || {}).finally(() => {
    oauthStartPromise = null;
  });
  return oauthStartPromise;
}

async function startOAuthInternal(options = {}) {
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

  // 授权目标：显式 accountId 为重新授权该账户；否则激活账户缺有效 token 时
  // 视为重新授权它（面板授权横幅的场景）；其余情况授权成功即新建账户
  let targetAccountId = typeof options.accountId === 'string' ? options.accountId : null;
  if (!targetAccountId && !options.forceNew) {
    const store = await readAccountStore();
    const active = activeAccountOf(store);
    if (active && (active.needsReauth || !isTokenShapeValid(active.token))) {
      targetAccountId = active.id;
    }
  }
  const label = String(options.label || '').trim().slice(0, 30);

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
    authorizationUrl: data.verification_uri_complete || data.verification_uri || '',
    accountId: targetAccountId,
    label
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

// 供扩展弹窗查询当前授权状态与账户列表
export async function authStatus() {
  await loadPendingAuthorization();
  if (pendingAuthorization && Date.now() >= pendingAuthorization.expiresAt) {
    await clearPendingAuthorization({ closeTab: true });
  }
  const store = await readAccountStore();
  const accounts = store.accounts.map((account) => ({
    id: account.id,
    label: account.label,
    active: account.id === store.activeId,
    needsReauth: Boolean(account.needsReauth || !isTokenShapeValid(account.token))
  }));
  // 与额度请求走同一有效性检查：必要时刷新过期 token；刷新失败则不能继续显示“已授权”。
  const token = await getValidTokenForAccount(activeAccountOf(store));
  if (!token) {
    return {
      ok: true,
      authorized: false,
      pending: Boolean(pendingAuthorization),
      userCode: pendingAuthorization?.userCode || '',
      accounts,
      activeId: store.activeId
    };
  }
  return {
    ok: true,
    authorized: true,
    expiresAt: token.expires_at * 1_000,
    pending: Boolean(pendingAuthorization),
    accounts,
    activeId: store.activeId
  };
}

// 添加新账户：强制走新建分支的设备授权流程，可携带备注名
export function addAccountOAuth(payload) {
  return startOAuth({ forceNew: true, label: payload?.label });
}

// 重新授权指定账户（保留备注名，完成后成为激活账户）
export function reauthAccountOAuth(payload) {
  return startOAuth({ accountId: payload?.id });
}

// 切换激活账户；额度缓存按账户隔离，面板先显示该账户缓存再强制刷新
export async function switchAccount(payload) {
  const id = payload?.id;
  const store = await readAccountStore();
  if (!store.accounts.some((account) => account.id === id)) {
    return failure(new Error('账户不存在'));
  }
  if (store.activeId !== id) {
    store.activeId = id;
    await writeAccountStore(store);
    broadcastAuthState('auth.switched');
  }
  return { ok: true, activeId: store.activeId };
}

// 移除账户；移除激活账户时自动切到剩余第一个，无剩余则回到未授权状态
export async function removeAccount(payload) {
  const id = payload?.id;
  const store = await readAccountStore();
  const next = store.accounts.filter((account) => account.id !== id);
  if (next.length === store.accounts.length) return failure(new Error('账户不存在'));
  const wasActive = store.activeId === id;
  store.accounts = next;
  if (wasActive) store.activeId = next[0]?.id || null;
  await writeAccountStore(store);
  refreshPromises.delete(id);
  hooks.invalidateQuotaCache(id);
  await hooks.clearQuotaAlertState(id);
  if (wasActive) broadcastAuthState(next.length ? 'auth.switched' : 'auth.cleared');
  return { ok: true, activeId: store.activeId };
}

export async function renameAccount(payload) {
  const id = payload?.id;
  const label = String(payload?.label || '').trim().slice(0, 30);
  if (!label) return failure(new Error('备注名不能为空'));
  const store = await readAccountStore();
  const account = store.accounts.find((item) => item.id === id);
  if (!account) return failure(new Error('账户不存在'));
  account.label = label;
  await writeAccountStore(store);
  return { ok: true };
}


export async function resetAndStartOAuth() {
  authRevision += 1;
  const store = await readAccountStore();
  const active = activeAccountOf(store);
  if (active) {
    active.token = null;
    active.needsReauth = true;
    await writeAccountStore(store);
    hooks.invalidateQuotaCache(active.id);
    refreshPromises.delete(active.id);
  }
  await clearPendingAuthorization({ closeTab: true });
  // 通知内容脚本重新显示新手引导
  await chrome.storage.local.set({ kimiOnboardingResetAt: Date.now() });
  broadcastAuthState('auth.cleared');
  // authRevision 已递增，进行中的旧授权流程注定在 revision 检查处失败。
  // 先等旧流程结束（同 disconnectCliUsage 等待进行中扫描的模式），否则 startOAuth
  // 的单飞会把这个必败的旧 promise 直接返回给调用方，新流程不会启动。
  if (oauthStartPromise) await oauthStartPromise.catch(() => {});
  return startOAuth(active ? { accountId: active.id } : {});
}

// 仅清除授权（测试或换账户前的重置）：清空全部账户
export async function clearAuth() {
  authRevision += 1;
  await chrome.storage.local.remove([ACCOUNTS_STORAGE_KEY, TOKEN_STORAGE_KEY]);
  await clearPendingAuthorization({ closeTab: true });
  hooks.invalidateQuotaCache(null);
  refreshPromises.clear();
  // 通知内容脚本重新显示新手引导
  await chrome.storage.local.set({ kimiOnboardingResetAt: Date.now() });
  broadcastAuthState('auth.cleared');
  return { ok: true };
}

export async function clearPendingAuthorization({ closeTab = false } = {}) {
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

// token 刷新按账户 id 单飞：同一账户共享进行中的刷新，不同账户互不阻塞
export function refreshTokenSingleFlight(accountId, token) {
  const existing = refreshPromises.get(accountId);
  if (existing) return existing;
  const promise = refreshToken(accountId, token).finally(() => {
    if (refreshPromises.get(accountId) === promise) refreshPromises.delete(accountId);
  });
  refreshPromises.set(accountId, promise);
  return promise;
}

async function refreshToken(accountId, token) {
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
  let found = false;
  await updateAccountInStore(accountId, (account) => {
    found = true;
    // 刷新期间账户被移除或已重新授权换新 token：旧结果直接作废
    if (account.token && account.token.refresh_token !== token.refresh_token) {
      throw new Error('授权状态已改变');
    }
    account.token = refreshed;
    account.needsReauth = false;
  });
  if (!found) throw new Error('授权状态已改变');
  return refreshed;
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
  return fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        ...(await identityHeaders())
      },
      body: new URLSearchParams(parameters).toString()
    },
    20_000
  );
}

let deviceIdPromise = null;

async function ensureDeviceId() {
  const stored = await chrome.storage.local.get(DEVICE_ID_STORAGE_KEY);
  if (stored[DEVICE_ID_STORAGE_KEY]) return stored[DEVICE_ID_STORAGE_KEY];
  if (deviceIdPromise) return deviceIdPromise;
  deviceIdPromise = (async () => {
    const stored2 = await chrome.storage.local.get(DEVICE_ID_STORAGE_KEY);
    if (stored2[DEVICE_ID_STORAGE_KEY]) return stored2[DEVICE_ID_STORAGE_KEY];
    const deviceId = crypto.randomUUID();
    await chrome.storage.local.set({ [DEVICE_ID_STORAGE_KEY]: deviceId });
    return deviceId;
  })().finally(() => {
    deviceIdPromise = null;
  });
  return deviceIdPromise;
}

async function identityHeaders() {
  const deviceId = await ensureDeviceId();
  return {
    'X-Msh-Platform': 'kimi_code_cli',
    'X-Msh-Version': chrome.runtime.getManifest().version,
    'X-Msh-Device-Id': deviceId,
    'X-Msh-Device-Name': 'Chrome Extension',
    'X-Msh-Device-Model': navigator.userAgent,
    'X-Msh-Os-Version': navigator.platform || 'unknown'
  };
}

export async function httpError(label, response) {
  const data = await response.json().catch(() => ({}));
  const detail = data?.error?.message || data?.error_description || data?.message || data?.error;
  return new Error(`${label} HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
}

// 授权域内的 token 形状校验与按账户取有效 token（额度/命名共用）
export async function getValidTokenForAccount(account) {
  if (!account || account.needsReauth) return null;
  const token = account.token;
  if (!isTokenShapeValid(token)) return null;

  const now = Math.floor(Date.now() / 1_000);
  if (token.expires_at > now + REFRESH_MARGIN_SECONDS) return token;
  return refreshTokenSingleFlight(account.id, token).catch(() => null);
}

export function isTokenShapeValid(token) {
  return Boolean(
    token &&
    typeof token.access_token === 'string' && token.access_token &&
    typeof token.refresh_token === 'string' && token.refresh_token &&
    Number.isFinite(token.expires_at)
  );
}
