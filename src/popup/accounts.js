/**
 * Kimi 账户板块：多账户列表（切换/改名/重新授权/移除/添加）与设备授权轮询。
 */
import { send, AUTH_POLL_INTERVAL_MS, pageState } from './shared.js';
import { t } from '../i18n.js';

const authHint = document.getElementById('auth-hint');
const accountAuthBtn = document.getElementById('account-auth-btn');
let pollTimer = null;

// 弹窗/options 关闭时停止授权轮询
window.addEventListener('pagehide', () => {
  pageState.pageDestroyed = true;
  stopPolling();
});

/* ---------- Kimi 账户：多账户列表（切换/改名/重新授权/移除/添加） ---------- */

let kimiAccounts = [];

// 默认备注名（扩展自己生成的「账户 N」）按界面语言显示；用户自定义名原样返回
function displayAccountName(label) {
  const m = /^账户 (\d+)$/.exec(String(label || ''));
  return m ? t('账户 {n}', { n: m[1] }) : label;
}
let flowActive = false;
// 授权流程启动前的基线，轮询据此判断流程是真的完成还是超时/被取消
let flowBaseline = null;
let sawUnauthorizedDuringFlow = false;

// 授权流程进行中禁用授权入口，避免重复发起
function setAuthBusy(disabled) {
  accountAuthBtn.disabled = disabled;
}

function renderAuthStatus(response) {
  kimiAccounts = Array.isArray(response?.accounts) ? response.accounts : [];
  renderKimiAccounts();
}

function renderKimiAccounts() {
  const list = document.getElementById('account-list');
  if (!list) return;
  list.replaceChildren();
  // 零账户显示空态「去授权」，有账户才显示「+ 添加账户」
  const hasAccounts = kimiAccounts.length > 0;
  document.getElementById('account-empty').classList.toggle('hidden', hasAccounts);
  document.getElementById('account-add-btn').classList.toggle('hidden', !hasAccounts);
  for (const account of kimiAccounts) {
    const row = document.createElement('div');
    row.className = 'ext-row';

    const name = document.createElement('span');
    name.className = 'ext-name';
    // 默认备注名（账户 N）按界面语言显示；用户自定义名原样
    const displayAccountLabel = displayAccountName(account.label);
    name.textContent = account.needsReauth ? `${displayAccountLabel}${t('（需重新授权）')}` : displayAccountLabel;
    name.title = name.textContent;
    row.append(name);

    const actions = document.createElement('span');
    actions.className = 'status-actions';

    if (account.active) {
      const badge = document.createElement('span');
      badge.className = 'account-badge';
      badge.textContent = t('当前');
      actions.append(badge);
    } else {
      actions.append(makeAccountButton(t('切换'), 'action primary', async (button) => {
        const response = await send('accounts.switch', { id: account.id });
        if (!response?.ok) throw new Error(response?.error || t('切换失败'));
        await refreshStatus();
      }, t('切换失败')));
    }

    actions.append(makeAccountButton(t('改名'), 'action', async () => {
      startAccountRename(row, account);
    }));

    if (account.needsReauth) {
      actions.append(makeAccountButton(t('重新授权'), 'action', async () => {
        await startOAuthFlow(
          account.active ? send('oauth.reset') : send('oauth.reauth', { id: account.id })
        );
      }));
    }

    actions.append(makeAccountButton(t('移除'), 'action', async (button) => {
      const response = await send('accounts.remove', { id: account.id });
      if (!response?.ok) throw new Error(response?.error || t('移除失败'));
      await refreshStatus();
    }, t('移除失败')));

    row.append(actions);
    list.append(row);
  }
}

// 行内文字按钮：失败时在授权提示区报错并恢复可点
function makeAccountButton(text, className, onClick, errorPrefix = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = text;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await onClick(button);
    } catch (error) {
      showHint(t('{name}失败：{msg}', { name: errorPrefix || text, msg: error.message || error }));
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

// 改名为行内编辑：Enter/保存提交，Escape 取消
function startAccountRename(row, account) {
  row.replaceChildren();
  const input = document.createElement('input');
  input.type = 'text';
  input.value = account.label;
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
      const response = await send('accounts.rename', { id: account.id, label });
      if (!response?.ok) throw new Error(response?.error || '改名失败');
      await refreshStatus();
    } catch (error) {
      showHint(t('改名失败：{msg}', { msg: error.message || error }));
      saveBtn.disabled = false;
    }
  };
  saveBtn.addEventListener('click', submit);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submit();
    if (event.key === 'Escape') renderKimiAccounts();
  });
  row.append(input, saveBtn);
  input.focus();
  input.select();
}

export async function refreshStatus() {
  try {
    const response = await send('auth.status');
    if (response?.ok && response.authorized) {
      stopPolling();
      setAuthBusy(false);
      renderAuthStatus(response);
    } else if (response?.pending) {
      setAuthBusy(true);
      showHint(t('请在授权页完成授权。'), response.userCode);
      kimiAccounts = Array.isArray(response?.accounts) ? response.accounts : [];
      renderKimiAccounts();
      if (!pollTimer) pollTimer = setInterval(poll, AUTH_POLL_INTERVAL_MS);
    } else {
      stopPolling();
      setAuthBusy(false);
      renderAuthStatus(response);
    }
  } catch (error) {
    stopPolling();
    showHint(t('状态查询失败：{msg}', { msg: error.message || error }));
  }
}

function showHint(message, userCode = '') {
  authHint.replaceChildren();
  authHint.append(document.createTextNode(message));
  if (userCode) {
    authHint.append(document.createElement('br'), document.createTextNode(t('验证码：')));
    const strong = document.createElement('strong');
    strong.textContent = userCode;
    authHint.append(strong);
  }
  authHint.classList.remove('hidden');
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

// 统一的授权流程入口：记录基线、启动流程、开始轮询（添加账户/重新授权共用）
async function startOAuthFlow(startPromise) {
  if (pollTimer) return;
  setAuthBusy(true);
  showHint(t('正在打开 Kimi 授权页…'));
  try {
    const baseline = await send('auth.status').catch(() => null);
    flowBaseline = {
      activeId: baseline?.activeId || null,
      authorized: Boolean(baseline?.authorized)
    };
    sawUnauthorizedDuringFlow = false;
    flowActive = true;
    const response = await startPromise;
    if (!response?.ok) throw new Error(response?.error || t('无法开始授权'));
    showHint(t('已在新标签页打开授权页，请完成授权；关闭本弹窗不影响授权。'), response.userCode);
    pollTimer = setInterval(poll, AUTH_POLL_INTERVAL_MS);
    poll();
  } catch (error) {
    flowActive = false;
    flowBaseline = null;
    showHint(t('授权启动失败：{msg}', { msg: error.message || error }));
    setAuthBusy(false);
  }
}

// 后台在驱动授权轮询，弹窗只需周期性查询授权状态
async function poll() {
  try {
    const response = await send('auth.status');
    // 仅当后台明确返回「未授权且已不在 pending」时才记为经历过未授权，
    // 避免 pending 态的瞬时 authorized===false 被误判为已取消/已授权。
    if (response && response.authorized === false && !response.pending) {
      sawUnauthorizedDuringFlow = true;
    }
    if (response?.pending) {
      showHint(t('请在授权页完成授权。'), response.userCode);
      return;
    }
    // 后台轮询已结束：授权完成（新账户/新激活/经历过未授权后恢复）或超时取消
    stopPolling();
    const completed = Boolean(response?.authorized) && flowActive && (
      !flowBaseline?.authorized ||
      sawUnauthorizedDuringFlow ||
      response.activeId !== flowBaseline?.activeId
    );
    flowActive = false;
    flowBaseline = null;
    if (completed) {
      showHint(t('授权成功，状态栏会自动恢复显示。'));
    } else {
      showHint(t('授权未完成（已超时或被取消），请重试。'));
    }
    setAuthBusy(false);
    renderAuthStatus(response);
  } catch (error) {
    stopPolling();
    flowActive = false;
    flowBaseline = null;
    showHint(t('状态查询失败：{msg}', { msg: error.message || error }));
    setAuthBusy(false);
  }
}

// 零账户空态的「去授权」：直接走添加账户流程（备注名留空，授权后可改）
accountAuthBtn.addEventListener('click', () => {
  startOAuthFlow(send('oauth.add', { label: '' }));
});

// 添加账户：先填备注名（可留空），再走设备授权流程；授权后仍可改名
const accountAddBtn = document.getElementById('account-add-btn');
const accountAddPanel = document.getElementById('account-add');
const accountLabelInput = document.getElementById('account-label-input');
accountAddBtn.addEventListener('click', () => {
  accountAddPanel.classList.toggle('hidden');
  accountAddBtn.classList.toggle('hidden', !accountAddPanel.classList.contains('hidden'));
  accountLabelInput.focus();
});
document.getElementById('account-add-save').addEventListener('click', async () => {
  const label = accountLabelInput.value.trim();
  accountAddPanel.classList.add('hidden');
  accountAddBtn.classList.remove('hidden');
  accountLabelInput.value = '';
  await startOAuthFlow(send('oauth.add', { label }));
});

