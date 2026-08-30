/**
 * 动态站点授权板块：当前标签页是非本机的 http(s) 页面（如 kimi web --host
 * 暴露的局域网地址、或 kimi rc 的云端中继页）时显示，样式与「本地记录已授权」
 * 行完全一致：圆点 + 状态文字 + 右侧文字按钮。
 * 权限申请必须发生在点击手势里（optional_host_permissions），登记与注入
 * 交给后台 dynamic-hosts 域完成。
 */
import { send, UI_MESSAGE_RESET_MS } from './shared.js';
import { t } from '../i18n.js';

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

export async function initHostsSection() {
  const row = document.getElementById('hosts-row');
  const dot = document.getElementById('hosts-status-dot');
  const text = document.getElementById('hosts-status-text');
  const enableBtn = document.getElementById('hosts-enable-btn');
  const reauthBtn = document.getElementById('hosts-reauth-btn');
  const cancelBtn = document.getElementById('hosts-cancel-btn');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  let url = null;
  try {
    url = tab?.url ? new URL(tab.url) : null;
  } catch {
    url = null;
  }
  // 本机回环由静态 content_scripts 覆盖；非 http(s) 页面无从授权，直接隐藏
  if (!url || !/^https?:$/.test(url.protocol) || LOCAL_HOSTNAMES.has(url.hostname)) return;

  const pattern = `${url.protocol}//${url.host}/*`;
  let enabled = false;
  row.classList.remove('hidden');

  async function refresh() {
    const registry = await send('hosts.list').catch(() => []);
    enabled = Array.isArray(registry) && registry.includes(pattern);
    dot.classList.toggle('ok', enabled);
    text.textContent = enabled ? t('已在此站点启用面板') : t('此站点未启用面板');
    enableBtn.classList.toggle('hidden', enabled);
    reauthBtn.classList.toggle('hidden', !enabled);
    cancelBtn.classList.toggle('hidden', !enabled);
  }

  // 操作结果在状态文字上短暂提示，随后恢复正常文案（与 cli 行的轻反馈一致）
  let noticeTimer = null;
  function flashNotice(message) {
    clearTimeout(noticeTimer);
    text.textContent = message;
    noticeTimer = setTimeout(() => {
      noticeTimer = null;
      refresh();
    }, UI_MESSAGE_RESET_MS);
  }

  function setButtonsDisabled(disabled) {
    enableBtn.disabled = disabled;
    reauthBtn.disabled = disabled;
    cancelBtn.disabled = disabled;
  }

  // 启用/重新启用：前者走浏览器授权弹窗（需用户手势），后者直接重新同步
  async function grant({ requestPermission }) {
    setButtonsDisabled(true);
    try {
      if (requestPermission) {
        const granted = await chrome.permissions.request({ origins: [pattern] });
        if (!granted) throw new Error(t('未授予站点访问权限'));
      }
      const response = await send('hosts.grant', { origin: pattern });
      if (!response?.ok) throw new Error(response?.error || t('启用失败'));
      await refresh();
      flashNotice(t('已在此站点启用面板'));
    } catch (error) {
      flashNotice(error?.message || String(error));
    } finally {
      setButtonsDisabled(false);
    }
  }

  async function revoke() {
    setButtonsDisabled(true);
    try {
      await chrome.permissions.remove({ origins: [pattern] }).catch(() => {});
      const response = await send('hosts.revoke', { origin: pattern });
      if (!response?.ok) throw new Error(response?.error || t('取消失败'));
      await refresh();
      flashNotice(t('此站点未启用面板'));
    } catch (error) {
      flashNotice(error?.message || String(error));
    } finally {
      setButtonsDisabled(false);
    }
  }

  enableBtn.addEventListener('click', () => grant({ requestPermission: true }));
  reauthBtn.addEventListener('click', () => grant({ requestPermission: false }));
  cancelBtn.addEventListener('click', revoke);

  await refresh();
}
