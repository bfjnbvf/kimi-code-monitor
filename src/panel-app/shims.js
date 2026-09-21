/**
 * 面板页（panel-app）的 chrome.* shim
 *
 * 桌面补丁的注入页面里没有 chrome.*：storage.local 落到 localStorage，
 * runtime.getURL 解析成面板资源目录的相对路径（注入模式资产经
 * window.__vibepalAssets 转 blob: URL），runtime.sendMessage 无对应通路，
 * 一律 resolve undefined（调用方的 .catch(() => {}) 兜底）。
 *
 * 求值顺序约束：本模块不得 import 任何业务模块——ES 模块的依赖先于模块自身
 * 求值，而 pet-panel.js 等在被求值时就要读 chrome.runtime.getURL。安装入口
 * 由 panel-app.js 的 import 顺序保证（shims 是第一个 import）。
 */

const RUNTIME_ID = 'vibepal-panel';

// localStorage 不可用（不透明来源等）时退化为内存存储，面板行为不中断
const memoryStore = new Map();
let localStorageWorks = true;
try {
  const probe = '__ksb_probe__';
  localStorage.setItem(probe, '1');
  localStorage.removeItem(probe);
} catch (error) {
  localStorageWorks = false;
}

function storageRead(key) {
  try {
    if (localStorageWorks) {
      const raw = localStorage.getItem(key);
      return raw === null ? undefined : JSON.parse(raw);
    }
  } catch (error) {
    // 解析失败按未存储处理，与 chrome.storage 的容错一致
  }
  return memoryStore.has(key) ? memoryStore.get(key) : undefined;
}

function storageWrite(key, value) {
  try {
    if (localStorageWorks) {
      localStorage.setItem(key, JSON.stringify(value));
      return;
    }
  } catch (error) {
    // 落入内存存储
  }
  memoryStore.set(key, value);
}

function storageDelete(key) {
  if (localStorageWorks) {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      // 忽略
    }
  }
  memoryStore.delete(key);
}

// chrome.storage.local.get：字符串 / 字符串数组 / null（全部）三种入参，
// 返回只含存在键的对象（与 chrome.storage 语义一致）
function storageLocalGet(keys) {
  return new Promise((resolve) => {
    const want = keys == null
      ? []
      : Array.isArray(keys)
        ? keys
        : typeof keys === 'object'
          ? Object.keys(keys)
          : [keys];
    const result = {};
    if (keys == null) {
      // 全量读取：localStorage 里以 kimi-statusbar./kimiCli 开头的面板相关键
      if (localStorageWorks) {
        try {
          for (let i = 0; i < localStorage.length; i += 1) {
            const key = localStorage.key(i);
            const value = storageRead(key);
            if (value !== undefined) result[key] = value;
          }
        } catch (error) {
          // 忽略，退回内存存储
        }
      }
      for (const [key, value] of memoryStore) result[key] = value;
      resolve(result);
      return;
    }
    for (const key of want) {
      const value = storageRead(key);
      if (value !== undefined) result[key] = value;
    }
    resolve(result);
  });
}

function storageLocalSet(items) {
  return new Promise((resolve) => {
    for (const [key, value] of Object.entries(items || {})) storageWrite(key, value);
    resolve();
  });
}

function storageLocalRemove(keys) {
  return new Promise((resolve) => {
    const list = Array.isArray(keys) ? keys : keys == null ? [] : [keys];
    for (const key of list) storageDelete(key);
    resolve();
  });
}

const noopListenerHub = {
  addListener() {},
  removeListener() {},
  hasListener: () => false
};

// 扩展里的 chrome-extension://<id>/<path> 统一还原为 <path>（相对面板资源目录）；
// 已是相对路径的原样返回。
// 注入模式（CDP 注入桌面端页面）下资源不在同 origin：注入器预先把
// wasm/riv 等资产转成 blob: URL 挂在 window.__vibepalAssets，优先命中
function resolveResourcePath(path) {
  const rel = String(path || '').replace(/^chrome-extension:\/\/[^/]+\//, '');
  const assets = globalThis.__vibepalAssets;
  if (assets && typeof assets === 'object' && typeof assets[rel] === 'string') {
    return assets[rel];
  }
  return rel;
}

// 注入页面无后台域：sendMessage 一律按「无响应」处理，调用方 .catch 兜底
function sendMessage() {
  return Promise.resolve(undefined);
}

globalThis.chrome = {
  runtime: {
    id: RUNTIME_ID,
    getURL: resolveResourcePath,
    sendMessage,
    onMessage: noopListenerHub,
    onConnect: noopListenerHub,
    // 面板页不打开扩展自有页面，留 no-op 桩
    openOptionsPage: () => Promise.resolve()
  },
  storage: {
    local: {
      get: storageLocalGet,
      set: storageLocalSet,
      remove: storageLocalRemove,
      clear: () => storageLocalRemove(null)
    },
    onChanged: noopListenerHub
  }
};
