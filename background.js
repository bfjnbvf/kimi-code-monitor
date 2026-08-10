importScripts(
  'metrics.js',
  'cli-usage.js',
  'providers.js',
  'session-rename/rename-shared.js',
  'session-rename/rename-model.js'
);

const QUOTA_API = 'https://api.kimi.com/coding/v1/usages';
// 订阅页月额度（方案 A：复用设备 OAuth token，401 时静默降级，见 requestMonthlyStats）
const SUBSCRIPTION_STATS_API = 'https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats';
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
// 月额度最后一次成功值（web token 断供时回退显示，不再横杠）
const QUOTA_MONTHLY_STORAGE_KEY = 'quotaMonthlyLast';
// 三档额度每日快照（导出用），复用额度拉取，零额外请求
const QUOTA_SNAPSHOT_STORAGE_KEY = 'quotaSnapshots';
const QUOTA_SNAPSHOT_INTERVAL_MS = 6 * 3_600_000;
const QUOTA_SNAPSHOT_KEEP_DAYS = 90;
const QUOTA_ALERT_STORAGE_KEY = 'quotaAlertState';
const REFRESH_MARGIN_SECONDS = 300;
const DEVICE_POLL_ALARM = 'kimi-device-auth-poll';
const MIN_DEVICE_POLL_DELAY_MS = 30_000;
const QUOTA_CACHE_TTL_MS = 30_000;

let pendingAuthorization = null;
let devicePollTimer = null;
let devicePollPromise = null;
let oauthStartPromise = null;
// token 刷新单飞与额度缓存都按账户 id 隔离：多账户切换互不影响
const refreshPromises = new Map();
let quotaFetchPromise = null;
const quotaCacheByAccount = new Map();
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
 * 预警状态按账户隔离，且本函数只由激活账户的额度拉取触发，
 * 非激活账户不会触发桌面通知。
 * 不做后台定时拉取，保持低功耗：没有 Kimi 标签页活动时不触发。 */
async function evaluateQuotaAlerts(data, accountKey = 'default') {
  try {
    const percentages = extractQuotaPercentages(data);
    const stored = await chrome.storage.local.get(QUOTA_ALERT_STORAGE_KEY);
    const state =
      stored[QUOTA_ALERT_STORAGE_KEY] && typeof stored[QUOTA_ALERT_STORAGE_KEY] === 'object'
        ? { ...stored[QUOTA_ALERT_STORAGE_KEY] }
        : {};
    const accountState =
      state[accountKey] && typeof state[accountKey] === 'object' ? { ...state[accountKey] } : {};
    let changed = false;
    for (const [key, pct] of Object.entries(percentages)) {
      if (pct == null) continue;
      const previousLevel = accountState[key]?.level || 0;
      const level = pct >= 95 ? 95 : pct >= 80 ? 80 : 0;
      if (level > previousLevel) notifyQuotaThreshold(key, level, pct);
      if (level !== previousLevel) {
        accountState[key] = { level };
        changed = true;
      }
    }
    if (changed) {
      state[accountKey] = accountState;
      await chrome.storage.local.set({ [QUOTA_ALERT_STORAGE_KEY]: state });
    }
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
  const account = await completeAccountAuthorization(authorization, token);
  quotaCacheByAccount.delete(account.id);
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
    'rename.batch.start': startRenameBatch,
    'rename.batch.status': getRenameBatchStatus,
    'rename.batch.abort': abortRenameBatch,
    'rename.usage.get': getRenameUsage,
    'rename.models.list': listRenameModels
  };
  const handler = handlers[message?.type];
  if (!handler) return false;

  handler(message.payload)
    .then(sendResponse)
    .catch((error) => sendResponse(failure(error)));
  return true;
});

/* ---------- 外部 provider 余额/额度（DeepSeek / Kimi API / 智谱 / MiniMax） ----------
 * 账户模型：同一 provider 可添加多个 key。key 由 popup 在用户手势下保存并申请
 * 对应域名权限（optional_host_permissions）；只存本机，不上传。
 * key 加密落盘：AES-GCM 密钥以不可导出（non-extractable）形式存 IndexedDB，
 * chrome.storage.local 里只有密文；直接拷走存储文件无法还原。 */
const EXTERNAL_ACCOUNTS_STORAGE_KEY = 'externalAccounts';
const EXTERNAL_LEGACY_KEYS_STORAGE_KEY = 'externalProviderKeys';
const EXTERNAL_CACHE_TTL_MS = 60_000;
const externalProviderCache = new Map();

const VAULT_DB_NAME = 'kimi-code-monitor-vault';
const VAULT_STORE = 'keys';
const VAULT_KEY_ID = 'external-accounts-aes-gcm';

function openVaultDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(VAULT_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(VAULT_STORE)) db.createObjectStore(VAULT_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法打开密钥库'));
  });
}

// 读取或首次生成 AES-GCM 密钥；extractable=false，JS 无法导出原始密钥材料
async function getVaultKey() {
  const db = await openVaultDb();
  try {
    const existing = await new Promise((resolve, reject) => {
      const request = db.transaction(VAULT_STORE, 'readonly').objectStore(VAULT_STORE).get(VAULT_KEY_ID);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (existing) return existing;
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt'
    ]);
    await new Promise((resolve, reject) => {
      const request = db.transaction(VAULT_STORE, 'readwrite').objectStore(VAULT_STORE).put(key, VAULT_KEY_ID);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    return key;
  } finally {
    db.close();
  }
}

function bytesToBase64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function base64ToBytes(text) {
  return Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));
}

async function encryptSecret(plaintext) {
  const key = await getVaultKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return { v: 1, iv: bytesToBase64(iv), data: bytesToBase64(data) };
}

async function decryptSecret(record) {
  const key = await getVaultKey();
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(record.iv) },
    key,
    base64ToBytes(record.data)
  );
  return new TextDecoder().decode(plain);
}

function sanitizeExternalKey(value) {
  // header 只接受可见 ASCII；粘贴混入的全角/不可见字符直接剔除
  return String(value || '').replace(/[^\x21-\x7E]/g, '');
}

async function readExternalAccounts() {
  const stored = await chrome.storage.local.get([
    EXTERNAL_ACCOUNTS_STORAGE_KEY,
    EXTERNAL_LEGACY_KEYS_STORAGE_KEY
  ]);
  const accounts = Array.isArray(stored[EXTERNAL_ACCOUNTS_STORAGE_KEY])
    ? [...stored[EXTERNAL_ACCOUNTS_STORAGE_KEY]]
    : [];
  let dirty = false;
  // 旧版按 provider 单 key 存储，迁移为账户列表
  const legacy = stored[EXTERNAL_LEGACY_KEYS_STORAGE_KEY] || {};
  for (const providerId of Object.keys(legacy).filter((id) => legacy[id])) {
    if (!accounts.some((a) => a.provider === providerId)) {
      accounts.push({
        id: `ext-${Date.now()}-${providerId}`,
        provider: providerId,
        key: sanitizeExternalKey(legacy[providerId])
      });
      dirty = true;
    }
  }
  if (dirty) await chrome.storage.local.remove(EXTERNAL_LEGACY_KEYS_STORAGE_KEY);
  // 明文 key 一律加密改写为密文（含旧版迁移过来的）
  for (const account of accounts) {
    if (account.key && !account.keyEnc) {
      const plain = sanitizeExternalKey(account.key);
      account.keyTail = plain.slice(-4);
      account.keyEnc = await encryptSecret(plain);
      delete account.key;
      dirty = true;
    }
  }
  if (dirty) {
    await chrome.storage.local.set({ [EXTERNAL_ACCOUNTS_STORAGE_KEY]: accounts });
  }
  return accounts;
}

async function fetchExternalAccount(account) {
  const provider = KimiExternalProviders.PROVIDERS[account.provider];
  if (!provider) return { id: account.id, name: account.provider, error: '未知 provider' };
  const base = {
    id: account.id,
    provider: account.provider,
    // 用户改名后优先显示备注名，缺省回退 provider 默认名
    name: account.label || provider.name,
    keyTail: account.keyTail || ''
  };
  const hasPermission = await chrome.permissions.contains({ origins: [`${provider.origin}/*`] });
  if (!hasPermission) return { ...base, error: '未授予域名权限' };
  let key;
  try {
    key = await decryptSecret(account.keyEnc);
  } catch (error) {
    return { ...base, error: '本机密钥不可用，请删除后重新添加' };
  }
  try {
    const result = await provider.fetch(key);
    return { ...base, ...result, error: '' };
  } catch (error) {
    return { ...base, error: error?.message || String(error) };
  }
}

async function getExternalProvidersStatus() {
  const accounts = await readExternalAccounts();
  const now = Date.now();
  const results = [];
  for (const account of accounts) {
    const cached = externalProviderCache.get(account.id);
    if (cached && now - cached.at < EXTERNAL_CACHE_TTL_MS) {
      results.push(cached.value);
      continue;
    }
    const value = await fetchExternalAccount(account);
    externalProviderCache.set(account.id, { at: now, value });
    results.push(value);
  }
  return { ok: true, providers: results };
}

async function addExternalAccount(payload) {
  const providerId = payload?.provider;
  const key = sanitizeExternalKey(payload?.key);
  const provider = KimiExternalProviders.PROVIDERS[providerId];
  if (!provider) return failure(new Error('未知 provider'));
  if (!key) return failure(new Error('API Key 为空或含非法字符'));
  const account = {
    id: `ext-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    provider: providerId,
    keyTail: key.slice(-4),
    keyEnc: await encryptSecret(key)
  };
  const accounts = await readExternalAccounts();
  accounts.push(account);
  await chrome.storage.local.set({ [EXTERNAL_ACCOUNTS_STORAGE_KEY]: accounts });
  // 保存后立即试拉一次，让 popup 能即时反馈 key 是否有效
  const result = await fetchExternalAccount(account);
  externalProviderCache.set(account.id, { at: Date.now(), value: result });
  return { ok: true, provider: result };
}

async function removeExternalAccount(payload) {
  const id = payload?.id;
  const accounts = await readExternalAccounts();
  const next = accounts.filter((account) => account.id !== id);
  await chrome.storage.local.set({ [EXTERNAL_ACCOUNTS_STORAGE_KEY]: next });
  externalProviderCache.delete(id);
  return { ok: true };
}

async function renameExternalAccount(payload) {
  const id = payload?.id;
  const label = String(payload?.label || '').trim().slice(0, 30);
  if (!label) return failure(new Error('备注名为空'));
  const accounts = await readExternalAccounts();
  const account = accounts.find((item) => item.id === id);
  if (!account) return failure(new Error('账户不存在'));
  account.label = label;
  await chrome.storage.local.set({ [EXTERNAL_ACCOUNTS_STORAGE_KEY]: accounts });
  // 缓存里带着旧名称，就地改掉，避免改名后还要等一次网络刷新
  const cached = externalProviderCache.get(id);
  if (cached) cached.value = { ...cached.value, name: label };
  return { ok: true };
}

/* ---------- 会话智能命名 ----------
 * content.js（127.0.0.1/localhost 页面）负责拉对话与取样，模型调用统一走这里。
 * modelSource：{ kind:'kimi-code', model } 用激活账户设备 token 调 api.kimi.com
 * （端点未实测，鉴权类失败返回 KIMI_MODEL_UNAVAILABLE，由 UI 引导改用外部账户）；
 * { kind:'external', accountId } 用已配置的外部账户（kimiapi/deepseek）。
 * 手动批量与模型清单都由 popup 发起，这里中转给活动 Kimi Code Web 标签页。
 * 每次成功的模型调用按响应 usage 累计到 sessionRenameUsage，供 popup 展示。 */
const RENAME_USAGE_STORAGE_KEY = 'sessionRenameUsage';

async function recordRenameUsage(usage) {
  if (!usage || typeof usage !== 'object') return;
  try {
    const stored = await chrome.storage.local.get(RENAME_USAGE_STORAGE_KEY);
    const totals = stored[RENAME_USAGE_STORAGE_KEY] || { calls: 0, input: 0, output: 0 };
    totals.calls += 1;
    totals.input += Number(usage.input) || 0;
    totals.output += Number(usage.output) || 0;
    totals.updatedAt = Date.now();
    await chrome.storage.local.set({ [RENAME_USAGE_STORAGE_KEY]: totals });
  } catch (error) {
    // 用量记录失败不影响命名主流程
  }
}

async function getRenameUsage() {
  const stored = await chrome.storage.local.get(RENAME_USAGE_STORAGE_KEY);
  return { ok: true, usage: stored[RENAME_USAGE_STORAGE_KEY] || { calls: 0, input: 0, output: 0 } };
}

async function renameModelCall(payload) {
  const prompt = String(payload?.prompt || '');
  if (!prompt) return failure(new Error('命名上下文为空'), 'EMPTY_PROMPT');
  const modelSource = KimiSessionRename.normalizeModelSource(payload?.modelSource);

  let result;
  if (modelSource.kind === 'kimi-code') {
    const store = await readAccountStore();
    const token = await getValidTokenForAccount(activeAccountOf(store));
    if (!token) return failure(new Error('Kimi Code 账户未授权'), 'AUTH_REQUIRED');
    result = await KimiSessionRenameModel.callKimiCode(token.access_token, prompt, modelSource.model);
  } else {
    const accounts = await readExternalAccounts();
    const account = accounts.find((item) => item.id === modelSource.accountId);
    if (!account) return failure(new Error('外部账户不存在'), 'ACCOUNT_NOT_FOUND');
    const provider = KimiExternalProviders.PROVIDERS[account.provider];
    if (!provider) return failure(new Error('未知 provider'), 'PROVIDER_UNSUPPORTED');
    const hasPermission = await chrome.permissions.contains({ origins: [`${provider.origin}/*`] });
    if (!hasPermission) return failure(new Error('未授予该外部账户的域名权限'), 'PERMISSION_REQUIRED');
    let key;
    try {
      key = await decryptSecret(account.keyEnc);
    } catch (error) {
      return failure(new Error('本机密钥不可用，请删除后重新添加'), 'KEY_UNAVAILABLE');
    }
    result = await KimiSessionRenameModel.callExternal(account.provider, key, prompt);
  }
  if (result?.ok && result.usage) await recordRenameUsage(result.usage);
  return result;
}

// 找活动 Kimi Code Web 标签页并转发消息；无页面/内容脚本未就绪时结构化报错
async function relayToKimiWebTab(type, payload) {
  const tabs = await chrome.tabs
    .query({ url: ['http://127.0.0.1/*', 'http://localhost/*'] })
    .catch(() => []);
  if (!tabs.length) return failure(new Error('没有打开的 Kimi Code Web 页面'), 'NO_WEB_TAB');
  const target = tabs.find((tab) => tab.active) || tabs[0];
  try {
    return await chrome.tabs.sendMessage(target.id, { type, payload });
  } catch (error) {
    return failure(new Error('命名面板未就绪，请刷新 Kimi Code Web 页面后重试'), 'CONTENT_UNAVAILABLE');
  }
}

// popup → 活动 Kimi Code Web 标签页的 content 脚本；进度由 content 直接广播回 popup
function startRenameBatch(payload) {
  return relayToKimiWebTab('rename.batch.run', payload);
}

// popup 查询批量状态（popup 重开时恢复进度显示）与请求中断
function getRenameBatchStatus() {
  return relayToKimiWebTab('rename.batch.status');
}

function abortRenameBatch() {
  return relayToKimiWebTab('rename.batch.abort');
}

// popup 拉命名模型清单：content 同源请求 /api/v1/models；失败时 popup 用硬编码兜底
function listRenameModels() {
  return relayToKimiWebTab('rename.models.fetch');
}

/* ---------- 本地 Kimi CLI 长期用量 ----------
 * 目录选择必须在 popup/options 的用户点击中完成；后台只读取已存入 IndexedDB
 * 的 sessions 目录句柄。CLI 文件是长期统计的权威来源，WebSocket 不与它相加。 */
let cliUsageScanPromise = null;
let cliUsageScanProgress = 0;
const CLI_AUTO_REFRESH_COOLDOWN_MS = 15_000;

async function getCliUsageStatus() {
  const handle = await KimiCliUsage.getDirectoryHandle().catch(() => null);
  const permission = await KimiCliUsage.permissionState(handle);
  const stored = await chrome.storage.local.get(KimiCliUsage.STATE_STORAGE_KEY);
  const state = stored[KimiCliUsage.STATE_STORAGE_KEY] || {};
  return {
    ok: true,
    connected: Boolean(handle) && permission === 'granted',
    permission,
    directoryName: handle?.name || state.directoryName || '',
    // service worker 若在扫描中途被回收，内存 promise 会消失；不能让旧的
    // scanning 持久值把授权操作永久锁死。
    scanning: cliUsageScanPromise != null,
    progress: cliUsageScanPromise != null ? cliUsageScanProgress : null,
    lastScannedAt: state.lastScannedAt || null,
    fileCount: Number(state.fileCount) || 0,
    error: state.error || ''
  };
}

async function refreshCliUsage(options = {}) {
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
    await chrome.storage.local.set({ [KimiCliUsage.STATE_STORAGE_KEY]: startedState });

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
      await chrome.storage.local.set({
        [KimiCliUsage.DAILY_STORAGE_KEY]: result.daily,
        [KimiCliUsage.INDEX_STORAGE_KEY]: result.index,
        [KimiCliUsage.SESSIONS_STORAGE_KEY]: result.sessions,
        // 授权了 .kimi-code 根目录时才有：次级模型（子代理）的真实模型名
        ...(result.secondaryModel
          ? { [KimiCliUsage.SECONDARY_MODEL_STORAGE_KEY]: result.secondaryModel }
          : {}),
        [KimiCliUsage.STATE_STORAGE_KEY]: state
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
      await chrome.storage.local.set({ [KimiCliUsage.STATE_STORAGE_KEY]: state });
      return failure(error, 'CLI_SCAN_FAILED');
    }
  })().finally(() => {
    cliUsageScanPromise = null;
  });
  return cliUsageScanPromise;
}

async function disconnectCliUsage() {
  // 先等待进行中的扫描写完，避免断开后被扫描结果“复活”为已连接
  if (cliUsageScanPromise) await cliUsageScanPromise.catch(() => {});
  await KimiCliUsage.clearDirectoryHandle().catch(() => {});
  await chrome.storage.local.remove([
    KimiCliUsage.DAILY_STORAGE_KEY,
    KimiCliUsage.INDEX_STORAGE_KEY,
    KimiCliUsage.SESSIONS_STORAGE_KEY,
    KimiCliUsage.STATE_STORAGE_KEY
  ]);
  broadcastCliUsageState('cli.usage.disconnected');
  return { ok: true };
}

async function openCliUsageSettings() {
  await chrome.runtime.openOptionsPage();
  return { ok: true };
}

function broadcastCliUsageState(type) {
  chrome.tabs
    .query({ url: ['http://127.0.0.1/*', 'http://localhost/*'] })
    .then((tabs) => {
      for (const tab of tabs) chrome.tabs.sendMessage(tab.id, { type }).catch(() => {});
    })
    .catch(() => {});
}

/* ---------- kimi.com 网页端 token 中转（月额度接口方案 B） ----------
 * web-token.js 在 www.kimi.com 页面读取网页端 access_token 上报至此缓存；
 * GetSubscriptionStats 只认这个 web token（设备 OAuth token 401）。 */
const WEB_TOKEN_STORAGE_KEY = 'kimiWebAccessToken';
const WEB_TOKEN_REFRESH_MARGIN_SECONDS = 120;

async function reportWebToken(payload) {
  const token = typeof payload?.token === 'string' ? payload.token : '';
  const expiresAt = Number(payload?.expiresAt);
  if (!token || !Number.isFinite(expiresAt) || expiresAt <= 0) {
    return { ok: false, error: 'token 无效' };
  }
  // 同一 token 不重复落盘，避免多标签页反复触发 storage 事件
  const stored = await chrome.storage.local.get(WEB_TOKEN_STORAGE_KEY);
  if (stored[WEB_TOKEN_STORAGE_KEY]?.token === token) return { ok: true, reused: true };
  await chrome.storage.local.set({
    [WEB_TOKEN_STORAGE_KEY]: { token, expiresAt, reportedAt: Date.now() }
  });
  return { ok: true };
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
    return null;
  }
}

function failure(error, code = 'REQUEST_FAILED') {
  return { ok: false, code, error: error?.message || String(error) };
}

async function fetchQuota(payload) {
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
  if (quotaFetchPromise) return quotaFetchPromise;

  quotaFetchPromise = fetchQuotaFresh().finally(() => {
    quotaFetchPromise = null;
  });
  return quotaFetchPromise;
}

async function fetchQuotaFresh() {
  const requestRevision = authRevision;
  const store = await readAccountStore();
  const account = activeAccountOf(store);
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
  if (requestRevision !== authRevision) {
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
async function resolveMonthlyStats(deviceAccessToken) {
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
    // 读取失败按无数据处理
  }
  return null;
}

// 三档额度每日快照（每 6 小时最多一条）；失败静默，不影响主链路
async function recordQuotaSnapshot(data) {
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
    // 快照失败不影响额度主链路
  }
}

function requestQuota(accessToken) {
  return fetch(QUOTA_API, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(20_000)
  });
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
    const response = await fetch(SUBSCRIPTION_STATS_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`
      },
      body: '{}',
      signal: AbortSignal.timeout(15_000)
    });
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
    return null;
  }
}

async function getValidTokenForAccount(account) {
  if (!account || account.needsReauth) return null;
  const token = account.token;
  if (!isTokenShapeValid(token)) return null;

  const now = Math.floor(Date.now() / 1_000);
  if (token.expires_at > now + REFRESH_MARGIN_SECONDS) return token;
  return refreshTokenSingleFlight(account.id, token).catch(() => null);
}

function isTokenShapeValid(token) {
  return Boolean(
    token &&
    typeof token.access_token === 'string' && token.access_token &&
    typeof token.refresh_token === 'string' && token.refresh_token &&
    Number.isFinite(token.expires_at)
  );
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

function activeAccountOf(store) {
  return store.accounts.find((account) => account.id === store.activeId) || null;
}

// 读取账户表；检测到旧版单 token 存储时迁移为首个账户（默认「账户 1」）并删除旧键
async function readAccountStore() {
  const stored = await chrome.storage.local.get([ACCOUNTS_STORAGE_KEY, TOKEN_STORAGE_KEY]);
  const raw = stored[ACCOUNTS_STORAGE_KEY];
  let store;
  let dirty = false;
  if (raw && typeof raw === 'object' && Array.isArray(raw.accounts)) {
    const accounts = raw.accounts.filter((account) => account && typeof account.id === 'string');
    dirty = accounts.length !== raw.accounts.length;
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
    await chrome.storage.local.remove(TOKEN_STORAGE_KEY);
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
  if (dirty) await writeAccountStore(store);
  return store;
}

async function writeAccountStore(store) {
  await chrome.storage.local.set({ [ACCOUNTS_STORAGE_KEY]: store });
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

// token 失效（刷新后仍 401）：清空该账户 token 并标记需重新授权；
// accessToken 不匹配说明已被并发流程换新，不动它
async function markAccountNeedsReauth(accountId, accessToken) {
  const store = await readAccountStore();
  const account = store.accounts.find((item) => item.id === accountId);
  if (!account) return;
  if (accessToken && account.token && account.token.access_token !== accessToken) return;
  account.token = null;
  account.needsReauth = true;
  await writeAccountStore(store);
  quotaCacheByAccount.delete(accountId);
}

// options：accountId 重新授权指定账户；forceNew 强制新建账户；label 新账户备注名
function startOAuth(options = {}) {
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
async function authStatus() {
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
function addAccountOAuth(payload) {
  return startOAuth({ forceNew: true, label: payload?.label });
}

// 重新授权指定账户（保留备注名，完成后成为激活账户）
function reauthAccountOAuth(payload) {
  return startOAuth({ accountId: payload?.id });
}

// 切换激活账户；额度缓存按账户隔离，面板先显示该账户缓存再强制刷新
async function switchAccount(payload) {
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
async function removeAccount(payload) {
  const id = payload?.id;
  const store = await readAccountStore();
  const next = store.accounts.filter((account) => account.id !== id);
  if (next.length === store.accounts.length) return failure(new Error('账户不存在'));
  const wasActive = store.activeId === id;
  store.accounts = next;
  if (wasActive) store.activeId = next[0]?.id || null;
  await writeAccountStore(store);
  quotaCacheByAccount.delete(id);
  refreshPromises.delete(id);
  await clearAccountAlertState(id);
  if (wasActive) broadcastAuthState(next.length ? 'auth.switched' : 'auth.cleared');
  return { ok: true, activeId: store.activeId };
}

async function renameAccount(payload) {
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

async function clearAccountAlertState(accountId) {
  try {
    const stored = await chrome.storage.local.get(QUOTA_ALERT_STORAGE_KEY);
    const state = stored[QUOTA_ALERT_STORAGE_KEY];
    if (state && typeof state === 'object' && accountId in state) {
      delete state[accountId];
      await chrome.storage.local.set({ [QUOTA_ALERT_STORAGE_KEY]: state });
    }
  } catch (error) {
    // 预警状态清理失败不影响账户移除
  }
}

// 重新授权当前激活账户：清掉该账户 token 后走完整设备授权流程
async function resetAndStartOAuth() {
  authRevision += 1;
  const store = await readAccountStore();
  const active = activeAccountOf(store);
  if (active) {
    active.token = null;
    active.needsReauth = true;
    await writeAccountStore(store);
    quotaCacheByAccount.delete(active.id);
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
async function clearAuth() {
  authRevision += 1;
  await chrome.storage.local.remove([ACCOUNTS_STORAGE_KEY, TOKEN_STORAGE_KEY]);
  await clearPendingAuthorization({ closeTab: true });
  quotaCacheByAccount.clear();
  refreshPromises.clear();
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

// token 刷新按账户 id 单飞：同一账户共享进行中的刷新，不同账户互不阻塞
function refreshTokenSingleFlight(accountId, token) {
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
  const store = await readAccountStore();
  const account = store.accounts.find((item) => item.id === accountId);
  // 刷新期间账户被移除或已重新授权换新 token：旧结果直接作废
  if (!account) throw new Error('授权状态已改变');
  if (account.token && account.token.refresh_token !== token.refresh_token) {
    throw new Error('授权状态已改变');
  }
  account.token = refreshed;
  account.needsReauth = false;
  await writeAccountStore(store);
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
