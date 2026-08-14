/**
 * popup 共享基础设施：消息超时、轮询/超时常量、页面状态（弹窗 / options 标签页）。
 */

export const SEND_TIMEOUT_MS = 8_000;
export const AUTH_POLL_INTERVAL_MS = 2_000;
export const CLI_PROGRESS_INTERVAL_MS = 500;
export const UI_MESSAGE_RESET_MS = 2_000;
export const BLOB_URL_REVOKE_MS = 1_000;

// options 标签页生命周期长，需要跟踪销毁做清理；弹窗关闭后脚本即终止。
export const pageState = {
  isOptionsTab: false,
  pageDestroyed: false
};

// popup.html 同时作为 options_ui（open_in_tab）打开；按实际场景加 class，
// 分别控制弹窗固定宽度和标签页自适应版式。
export function initMode() {
  chrome.tabs.getCurrent()
    .then((tab) => {
      pageState.isOptionsTab = Boolean(tab);
      document.body.classList.add(pageState.isOptionsTab ? 'is-options-tab' : 'is-popup');
    })
    .catch(() => {
      document.body.classList.add('is-popup');
    });
}

// 后台 service worker 可能休眠，消息加超时兜底，避免 UI 永久等待
export function send(type, payload) {
  return Promise.race([
    chrome.runtime.sendMessage({ type, payload }),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('请求超时，请刷新页面或重启扩展后重试')), SEND_TIMEOUT_MS);
    })
  ]);
}
