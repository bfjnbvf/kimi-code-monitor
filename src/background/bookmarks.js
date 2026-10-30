import { updateStorage } from './store.js';

const BOOKMARKS_STORAGE_KEY = 'kimi-statusbar.bookmarks';
const MAX_OPERATIONS = 500;

function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 &&
    !['__proto__', 'prototype', 'constructor'].includes(value);
}

function cleanItem(item) {
  return {
    title: typeof item?.title === 'string' ? item.title.slice(0, 4_001) : '',
    question: typeof item?.question === 'string' ? item.question.slice(0, 301) : '',
    html: typeof item?.html === 'string' ? item.html.slice(0, 150_001) : '',
    createdAt: Number.isFinite(item?.createdAt) ? item.createdAt : Date.now()
  };
}

// 所有标签页都通过 service worker 的同一存储锁按项更新，避免整库快照互相覆盖。
export async function mutateBookmarks(payload) {
  const operations = payload?.operations;
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > MAX_OPERATIONS) {
    throw new Error('收藏操作数量不合法');
  }
  const store = await updateStorage(BOOKMARKS_STORAGE_KEY, async (raw) => {
    const next = raw && typeof raw === 'object' ? structuredClone(raw) : { sessions: {} };
    if (!next.sessions || typeof next.sessions !== 'object' || Array.isArray(next.sessions)) {
      next.sessions = {};
    }
    for (const operation of operations) {
      const { sessionId, turnId } = operation || {};
      if (!validId(sessionId) || !validId(turnId)) throw new Error('收藏标识不合法');
      if (operation.type === 'remove') {
        const entry = next.sessions[sessionId];
        if (!entry || typeof entry !== 'object') continue;
        if (entry.items && typeof entry.items === 'object') delete entry.items[turnId];
        if (!entry.items || Object.keys(entry.items).length === 0) delete next.sessions[sessionId];
        continue;
      }
      if (operation.type === 'patch') {
        const item = next.sessions[sessionId]?.items?.[turnId];
        if (item && typeof operation.html === 'string') item.html = operation.html.slice(0, 150_001);
        continue;
      }
      if (operation.type !== 'upsert') throw new Error('收藏操作类型不合法');
      const entry = next.sessions[sessionId] && typeof next.sessions[sessionId] === 'object'
        ? next.sessions[sessionId]
        : { title: '', items: {} };
      if (!entry.items || typeof entry.items !== 'object' || Array.isArray(entry.items)) entry.items = {};
      if (!entry.title && typeof operation.sessionTitle === 'string') {
        entry.title = operation.sessionTitle.slice(0, 200);
      }
      entry.items[turnId] = cleanItem(operation.item);
      next.sessions[sessionId] = entry;
    }
    return next;
  });
  return { ok: true, store };
}
