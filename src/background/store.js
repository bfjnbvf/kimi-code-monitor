/**
 * background 共享基础设施：存储互斥锁 / 原子更新 / 超时 fetch / 标签页中转 / 结构化错误。
 */
import { queryKimiWebTabs } from './dynamic-hosts.js';

const storageLocks = new Map();

export async function withStorageLock(key, fn) {
  const prev = storageLocks.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  storageLocks.set(
    key,
    next.finally(() => {
      if (storageLocks.get(key) === next) storageLocks.delete(key);
    })
  );
  return next;
}

export async function updateStorage(key, updater) {
  return withStorageLock(key, async () => {
    const stored = await chrome.storage.local.get(key);
    const value = await updater(stored[key]);
    if (value === null) {
      await chrome.storage.local.remove(key);
    } else if (value !== undefined) {
      await chrome.storage.local.set({ [key]: value });
    }
    return value;
  });
}

// 统一网络请求超时层：不重试，只保证每个请求有上限。
export async function fetchWithTimeout(url, options = {}, ms = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('请求超时')), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}


export async function relayToKimiWebTab(type, payload) {
  const tabs = await queryKimiWebTabs();
  if (!tabs.length) return failure(new Error('没有打开的 Kimi Code Web 页面'), 'NO_WEB_TAB');
  const target = tabs.find((tab) => tab.active) || tabs[0];
  try {
    return await chrome.tabs.sendMessage(target.id, { type, payload });
  } catch (error) {
    return failure(new Error('命名面板未就绪，请刷新 Kimi Code Web 页面后重试'), 'CONTENT_UNAVAILABLE');
  }
}


export function failure(error, code = 'REQUEST_FAILED') {
  return { ok: false, code, error: error?.message || String(error) };
}
