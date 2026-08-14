/**
 * 会话智能命名域：命名模型调用中转（Kimi Code 内置/外部 provider）、用量累计、
 * 模型清单拉取。经 relayToKimiWebTab 与 content script 同源通讯。
 */

import * as KimiExternalProviders from '../providers.js';
import * as KimiSessionRename from '../session-rename/rename-shared.js';
import * as KimiSessionRenameModel from '../session-rename/rename-model.js';
import { updateStorage, failure, fetchWithTimeout, relayToKimiWebTab } from './store.js';
import { decryptSecret } from './vault.js';
import { readAccountStore, activeAccountOf, getValidTokenForAccount } from './oauth.js';
import { readExternalAccounts } from './external.js';

/* ---------- 会话智能命名 ----------
 * content.js（127.0.0.1/localhost 页面）负责拉对话与取样，模型调用统一走这里。
 * modelSource：{ kind:'kimi-code', model } 用激活账户设备 token 调 api.kimi.com
 * （端点未实测，鉴权类失败返回 KIMI_MODEL_UNAVAILABLE，由 UI 引导改用外部账户）；
 * { kind:'external', accountId } 用已配置的外部账户（kimiapi/deepseek）。
 * 模型清单由 popup 发起，这里中转给活动 Kimi Code Web 标签页。
 * 每次成功的模型调用按响应 usage 累计到 sessionRenameUsage，供 popup 展示。 */
const RENAME_USAGE_STORAGE_KEY = 'sessionRenameUsage';

async function recordRenameUsage(usage) {
  if (!usage || typeof usage !== 'object') return;
  try {
    await updateStorage(RENAME_USAGE_STORAGE_KEY, (totals) => {
      const next = totals && typeof totals === 'object'
        ? { ...totals }
        : { calls: 0, input: 0, output: 0 };
      next.calls = (next.calls || 0) + 1;
      next.input = (next.input || 0) + (Number(usage.input) || 0);
      next.output = (next.output || 0) + (Number(usage.output) || 0);
      next.updatedAt = Date.now();
      return next;
    });
  } catch (error) {
    console.warn('[Kimi Status] 命名用量记录失败', error);
  }
}

export async function getRenameUsage() {
  const stored = await chrome.storage.local.get(RENAME_USAGE_STORAGE_KEY);
  return { ok: true, usage: stored[RENAME_USAGE_STORAGE_KEY] || { calls: 0, input: 0, output: 0 } };
}

export async function renameModelCall(payload) {
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
    result = await KimiSessionRenameModel.callExternal(account.provider, key, prompt, modelSource.model);
  }
  if (result?.ok && result.usage) await recordRenameUsage(result.usage);
  return result;
}

// 外部账户的命名模型列表：解密账户 key 后调各 provider 的 /models（OpenAI 兼容）。
// 拉取失败（无权限/网络/HTTP 错误）回落该 provider 的兜底默认模型，保证下拉可用。
export async function listExternalRenameModels() {
  const supported = KimiSessionRenameModel.RENAME_MODEL_PROVIDERS || {};
  const accounts = await readExternalAccounts();
  const results = await Promise.allSettled(
    accounts.map(async (account) => {
      const target = supported[account.provider];
      if (!target) return null;
      const provider = KimiExternalProviders.PROVIDERS[account.provider];
      const base = {
        accountId: account.id,
        provider: account.provider,
        name: account.label || provider?.name || account.provider,
        models: []
      };
      try {
        const hasPermission = await chrome.permissions.contains({ origins: [`${provider.origin}/*`] });
        if (!hasPermission) throw new Error('未授予域名权限');
        const key = await decryptSecret(account.keyEnc);
        const resp = await fetchWithTimeout(
          target.modelsUrl,
          { headers: { Authorization: `Bearer ${key}` } },
          15_000
        );
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        const ids = (Array.isArray(data?.data) ? data.data : [])
          .map((item) => item?.id)
          .filter((id) => typeof id === 'string' && id);
        base.models = ids.length ? ids : [target.model];
      } catch (error) {
        base.models = [target.model];
        base.error = error?.message || String(error);
      }
      return base;
    })
  );
  return { ok: true, accounts: results.map((r) => r.value).filter(Boolean) };
}


export function listRenameModels() {
  return relayToKimiWebTab('rename.models.fetch');
}
