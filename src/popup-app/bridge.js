/**
 * popup 页的 Swift → JS 桥接收端
 *
 * 只处理 popup 需要的推送（msg 形如 { v: 1, type, ... }）：
 *   - { type: 'appInfo', version }：版本号写 footer
 *   - { type: 'usageDaily', daily, hourly, secondaryModel, connected }：
 *     写进 chrome.storage shim（localStorage），经 onChanged 事件总线触发
 *     popup/usage.js 的消耗量板块刷新——与扩展从 storage 读缓存同通路，
 *     渲染逻辑零改动。
 * 其余消息（quota/status/event/session/external…）popup 不消费，直接忽略。
 */

import { DAILY_STORAGE_KEY, HOURLY_STORAGE_KEY, STATE_STORAGE_KEY } from '../cli-usage.js';

function dispatch(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.v != null && msg.v !== 1) {
    console.warn('[Kimi Popup] 忽略未知版本的桥接消息', msg);
    return;
  }
  switch (msg.type) {
    case 'appInfo': {
      const el = document.getElementById('version');
      if (el && typeof msg.version === 'string') el.textContent = msg.version;
      break;
    }
    case 'usageDaily': {
      // 与扩展 storage 键同名：usage.js 的 onStorageChanged 据此刷新
      writeUsageStorage({
        [DAILY_STORAGE_KEY]: msg.daily && typeof msg.daily === 'object' ? msg.daily : {},
        [HOURLY_STORAGE_KEY]: msg.hourly && typeof msg.hourly === 'object' ? msg.hourly : {},
        [STATE_STORAGE_KEY]: { connected: msg.connected !== false }
      });
      break;
    }
    default:
      break;
  }
}

// shim 的 storage.local.set 会派发 onChanged；无 chrome 时（理论上不会）静默
function writeUsageStorage(items) {
  try {
    globalThis.chrome?.storage?.local?.set?.(items)?.catch?.(() => {});
  } catch (error) {
    // 存储不可用时仅影响刷新，不抛
  }
}

let popupBridgeReady = false;
const pendingMessages = [];

export function installPopupBridge() {
  globalThis.__vibepal = {
    push: (msg) => {
      if (!popupBridgeReady) {
        pendingMessages.push(msg);
        return;
      }
      dispatch(msg);
    }
  };
}

// popup 装配完成：补发排队期间到达的消息，之后 push 直达
export function markPopupBridgeReady() {
  if (popupBridgeReady) return;
  popupBridgeReady = true;
  while (pendingMessages.length) dispatch(pendingMessages.shift());
}
