/**
 * popup 页（独立弹层面板）的 chrome.* shim 扩展
 *
 * 复用 panel-app 的基础 shim（chrome 不存在时安装：storage.local →
 * localStorage、runtime.getURL → 相对路径、sendMessage → __vibepalAsk），
 * 在此之上补 popup 才需要的行为：
 * - storage.onChanged 真实事件总线：storage.local.set 后按 chrome 口径
 *   （{key:{newValue}}, 'local'）派发，usage.js 靠它做数据变更刷新
 * - chrome.permissions：App 侧抓取无 CORS / 域名权限概念，直接放行
 * - chrome.runtime.sendMessage 升级为请求/响应：消息带 __askId 经
 *   __vibepalAsk 送达 Swift，Swift 用 __vibepalAskReply(id, result) 回填
 *
 * 求值顺序约束与 panel-app/shims.js 相同：本模块只 import panel shim，
 * 不得 import 业务模块（pet-panel.js 等在被求值时要读 chrome.runtime.getURL）。
 */

import '../panel-app/shims.js';

/* ---------- storage.onChanged 事件总线 ---------- */

const storageListeners = new Set();

function emitStorageChanges(items) {
  if (!storageListeners.size) return;
  const changes = {};
  for (const [key, value] of Object.entries(items || {})) changes[key] = { newValue: value };
  for (const listener of [...storageListeners]) {
    try {
      listener(changes, 'local');
    } catch (error) {
      // 单个监听器异常不影响其他监听器
    }
  }
}

const baseStorageSet = globalThis.chrome.storage.local.set;
globalThis.chrome.storage.local.set = (items) => baseStorageSet(items).then(() => {
  emitStorageChanges(items);
});

globalThis.chrome.storage.onChanged = {
  addListener(listener) {
    if (typeof listener === 'function') storageListeners.add(listener);
  },
  removeListener(listener) {
    storageListeners.delete(listener);
  },
  hasListener(listener) {
    return storageListeners.has(listener);
  }
};

/* ---------- permissions：App 内抓取无域名授权概念 ---------- */

globalThis.chrome.permissions = {
  request: async () => true,
  contains: async () => true,
  remove: async () => true
};

/* ---------- runtime：版本 + 请求/响应式 sendMessage ---------- */

globalThis.chrome.runtime.getManifest = () => ({ version: '' });

const pendingAsks = new Map();
let askSeq = 0;

// Swift 侧经 evaluateJavaScript 调它回填结果（由页面内联脚本无法预先注入，
// shim 负责把全局挂上）
globalThis.__vibepalAskReply = (id, result) => {
  const key = String(id);
  const resolve = pendingAsks.get(key);
  if (!resolve) return;
  pendingAsks.delete(key);
  resolve(result);
};

globalThis.chrome.runtime.sendMessage = (message) => new Promise((resolve) => {
  const ask = globalThis.__vibepalAsk;
  if (typeof ask !== 'function') {
    resolve(undefined);
    return;
  }
  askSeq += 1;
  const id = `ask-${Date.now().toString(36)}-${askSeq}`;
  pendingAsks.set(id, resolve);
  try {
    ask({ ...(message || {}), __askId: id });
  } catch (error) {
    pendingAsks.delete(id);
    resolve(undefined);
  }
});
