/**
 * 外部 provider 域（DeepSeek / Kimi API / 智谱 / MiniMax）：
 * 账户 CRUD、余额/额度状态拉取；key 加密落盘（vault.js）。
 */

import * as KimiExternalProviders from '../providers.js';
import { withStorageLock, failure } from './store.js';
import { encryptSecret, decryptSecret } from './vault.js';

const EXTERNAL_ACCOUNTS_STORAGE_KEY = 'externalAccounts';
const EXTERNAL_LEGACY_KEYS_STORAGE_KEY = 'externalProviderKeys';
const EXTERNAL_CACHE_TTL_MS = 60_000;
const externalProviderCache = new Map();


function sanitizeExternalKey(value) {
  // header 只接受可见 ASCII；粘贴混入的全角/不可见字符直接剔除
  return String(value || '').replace(/[^\x21-\x7E]/g, '');
}

export async function readExternalAccounts() {
  return withStorageLock(EXTERNAL_ACCOUNTS_STORAGE_KEY, async () => {
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
  });
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

export async function getExternalProvidersStatus() {
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

export async function addExternalAccount(payload) {
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
  return withStorageLock(EXTERNAL_ACCOUNTS_STORAGE_KEY, async () => {
    const stored = await chrome.storage.local.get(EXTERNAL_ACCOUNTS_STORAGE_KEY);
    const accounts = Array.isArray(stored[EXTERNAL_ACCOUNTS_STORAGE_KEY])
      ? [...stored[EXTERNAL_ACCOUNTS_STORAGE_KEY]]
      : [];
    accounts.push(account);
    await chrome.storage.local.set({ [EXTERNAL_ACCOUNTS_STORAGE_KEY]: accounts });
    // 保存后立即试拉一次，让 popup 能即时反馈 key 是否有效
    const result = await fetchExternalAccount(account);
    externalProviderCache.set(account.id, { at: Date.now(), value: result });
    return { ok: true, provider: result };
  });
}

export async function removeExternalAccount(payload) {
  const id = payload?.id;
  return withStorageLock(EXTERNAL_ACCOUNTS_STORAGE_KEY, async () => {
    const stored = await chrome.storage.local.get(EXTERNAL_ACCOUNTS_STORAGE_KEY);
    const accounts = Array.isArray(stored[EXTERNAL_ACCOUNTS_STORAGE_KEY])
      ? [...stored[EXTERNAL_ACCOUNTS_STORAGE_KEY]]
      : [];
    const next = accounts.filter((account) => account.id !== id);
    await chrome.storage.local.set({ [EXTERNAL_ACCOUNTS_STORAGE_KEY]: next });
    externalProviderCache.delete(id);
    return { ok: true };
  });
}

export async function renameExternalAccount(payload) {
  const id = payload?.id;
  const label = String(payload?.label || '').trim().slice(0, 30);
  if (!label) return failure(new Error('备注名为空'));
  return withStorageLock(EXTERNAL_ACCOUNTS_STORAGE_KEY, async () => {
    const stored = await chrome.storage.local.get(EXTERNAL_ACCOUNTS_STORAGE_KEY);
    const accounts = Array.isArray(stored[EXTERNAL_ACCOUNTS_STORAGE_KEY])
      ? [...stored[EXTERNAL_ACCOUNTS_STORAGE_KEY]]
      : [];
    const account = accounts.find((item) => item.id === id);
    if (!account) return failure(new Error('账户不存在'));
    account.label = label;
    await chrome.storage.local.set({ [EXTERNAL_ACCOUNTS_STORAGE_KEY]: accounts });
    // 缓存里带着旧名称，就地改掉，避免改名后还要等一次网络刷新
    const cached = externalProviderCache.get(id);
    if (cached) cached.value = { ...cached.value, name: label };
    return { ok: true };
  });
}
