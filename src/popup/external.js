/**
 * 外部账户板块：DeepSeek / Kimi API / 智谱 / MiniMax 的添加（选类型 + 粘贴 key）与列表管理。
 */
import * as KimiExternalProviders from '../providers.js';
import { send, pageState } from './shared.js';
import { t } from '../i18n.js';

  /* ---------- 外部账户：加号添加（选类型 + 粘贴 key），列表管理 ---------- */

  function formatExternalStatus(provider) {
    if (provider.error) return { text: t('获取失败：{msg}', { msg: provider.error }), isError: true };
    if (provider.kind === 'balance') {
      const total = Number(provider.total);
      const granted = Number(provider.granted);
      const paid = Number(provider.paid);
      if (!Number.isFinite(total) || !Number.isFinite(granted) || !Number.isFinite(paid)) {
        return { text: t('余额数据异常'), isError: true };
      }
      return {
        text: t('余额 {total}（赠送 {granted} · 充值 {paid}）', { total: `${provider.currency || ''}${total.toFixed(2)}`, granted: granted.toFixed(2), paid: paid.toFixed(2) }),
        isError: false
      };
    }
    if (provider.windows?.length) {
      const parts = provider.windows
        .map((w) => {
          const pct = Number(w.pct);
          return Number.isFinite(pct) ? `${w.label} ${pct.toFixed(1)}%` : null;
        })
        .filter(Boolean);
      return { text: parts.length ? parts.join(' · ') : t('窗口数据异常'), isError: !parts.length };
    }
    return { text: provider.plan || t('已启用'), isError: false };
  }

  let externalAccountsCache = [];

  // rename 板块按账户生成模型下拉分组，这里只读缓存
  export function getExternalAccountsCache() {
    return externalAccountsCache;
  }

  function renderExternalAccounts(errorMessage = '') {
    const list = document.getElementById('external-list');
    if (!list) return;
    list.replaceChildren();
    for (const account of externalAccountsCache) {
      const row = document.createElement('div');
      row.className = 'ext-row';

      // textContent 赋值，名称/尾号不经 innerHTML，无注入面
      const name = document.createElement('span');
      name.className = 'ext-name';
      name.textContent = account.keyTail ? `${account.name} · ${account.keyTail}` : account.name;
      name.title = name.textContent;
      row.append(name);

      const actions = document.createElement('span');
      actions.className = 'status-actions';

      const renameBtn = document.createElement('button');
      renameBtn.type = 'button';
      renameBtn.className = 'action';
      renameBtn.textContent = t('改名');
      renameBtn.addEventListener('click', () => startExternalRename(row, account));
      actions.append(renameBtn);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'action';
      removeBtn.textContent = t('移除');
      removeBtn.addEventListener('click', async () => {
        removeBtn.disabled = true;
        try {
          const response = await send('external.remove', { id: account.id });
          if (!response?.ok) throw new Error(response?.error || t('移除失败'));
          externalAccountsCache = externalAccountsCache.filter((a) => a.id !== account.id);
          renderExternalAccounts();
        } catch (error) {
          renderExternalAccounts(t('移除失败：{msg}', { msg: error?.message || error }));
        }
      });
      actions.append(removeBtn);

      row.append(actions);
      list.append(row);
    }
    if (errorMessage) {
      const errEl = document.createElement('div');
      errEl.className = 'ext-status err';
      errEl.textContent = errorMessage;
      list.append(errEl);
    }
  }

  // 外部账户行内改名：Enter/保存提交，Escape 取消；label 由后台保存并覆盖 provider 默认名
  function startExternalRename(row, account) {
    row.replaceChildren();
    const input = document.createElement('input');
    input.type = 'text';
    input.value = account.name;
    input.maxLength = 30;
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'action primary';
    saveBtn.textContent = t('保存');
    const submit = async () => {
      const label = input.value.trim();
      if (!label) {
        input.focus();
        return;
      }
      saveBtn.disabled = true;
      try {
        const response = await send('external.rename', { id: account.id, label });
        if (!response?.ok) throw new Error(response?.error || t('改名失败'));
        await refreshExternalStatus();
      } catch (error) {
        renderExternalAccounts(t('改名失败：{msg}', { msg: error?.message || error }));
      }
    };
    saveBtn.addEventListener('click', submit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
      if (event.key === 'Escape') renderExternalAccounts();
    });
    row.append(input, saveBtn);
    input.focus();
    input.select();
  }

  export async function refreshExternalStatus() {
    try {
      const response = await send('external.status');
      if (pageState.pageDestroyed) return;
      if (!response?.ok) return;
      externalAccountsCache = response.providers || [];
      renderExternalAccounts();
    } catch (error) {
      // 状态拉取失败不阻塞其他区块，但保留错误提示
      console.warn('读取外部账户失败:', error);
      if (!pageState.pageDestroyed) renderExternalAccounts(t('状态读取失败，请稍后刷新'));
    }
  }

  export function buildExternalSection() {
    const select = document.getElementById('ext-provider-select');
    if (!select || !KimiExternalProviders) return;
    for (const [id, provider] of Object.entries(KimiExternalProviders.PROVIDERS)) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = `${provider.name}（${provider.typeLabel}）`;
      select.append(option);
    }
    const addPanel = document.getElementById('external-add');
    const addBtn = document.getElementById('ext-add-btn');
    const keyInput = document.getElementById('ext-key-input');
    const status = document.getElementById('ext-add-status');
    addBtn.addEventListener('click', () => {
      addPanel.classList.toggle('hidden');
      addBtn.classList.toggle('hidden', !addPanel.classList.contains('hidden'));
      keyInput.focus();
    });
    document.getElementById('ext-add-save').addEventListener('click', async (event) => {
      const providerId = select.value;
      const provider = KimiExternalProviders.PROVIDERS[providerId];
      const key = keyInput.value.trim();
      if (!key) {
        status.textContent = t('请先粘贴 API Key');
        status.classList.add('err');
        return;
      }
      const button = event.currentTarget;
      button.disabled = true;
      status.classList.remove('err');
      status.textContent = t('正在验证…');
      try {
        // 域名权限必须在用户手势里申请（optional_host_permissions）
        const granted = await chrome.permissions.request({ origins: [`${provider.origin}/*`] });
        if (!granted) throw new Error(t('未授予域名访问权限'));
        const response = await send('external.add', { provider: providerId, key });
        if (!response?.ok) throw new Error(response?.error || t('保存失败'));
        const result = formatExternalStatus(response.provider || {});
        status.textContent = result.isError ? result.text : t('已保存');
        status.classList.toggle('err', result.isError);
        keyInput.value = '';
        await refreshExternalStatus();
      } catch (error) {
        status.textContent = error?.message || String(error);
        status.classList.add('err');
      } finally {
        button.disabled = false;
      }
    });
  }

