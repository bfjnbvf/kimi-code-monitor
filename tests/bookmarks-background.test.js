import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.chrome = { permissions: { onRemoved: { addListener() {} } } };
const { mutateBookmarks } = await import('../src/background/bookmarks.js');

function installStorage(initial = {}) {
  const data = structuredClone(initial);
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          await new Promise((resolve) => setTimeout(resolve, 2));
          return Object.hasOwn(data, key) ? { [key]: structuredClone(data[key]) } : {};
        },
        async set(values) {
          await new Promise((resolve) => setTimeout(resolve, 2));
          Object.assign(data, structuredClone(values));
        },
        async remove(key) { delete data[key]; }
      }
    }
  };
  return data;
}

const upsert = (sessionId, turnId, title) => ({
  type: 'upsert', sessionId, turnId, sessionTitle: `会话 ${sessionId}`,
  item: { title, question: '', html: '', createdAt: 1 }
});

test('收藏按项原子更新：并发标签页写入不会互相覆盖', async () => {
  const data = installStorage();
  await Promise.all([
    mutateBookmarks({ operations: [upsert('s1', 't1', '回复一')] }),
    mutateBookmarks({ operations: [upsert('s2', 't2', '回复二')] })
  ]);
  const stored = data['kimi-statusbar.bookmarks'];
  assert.equal(stored.sessions.s1.items.t1.title, '回复一');
  assert.equal(stored.sessions.s2.items.t2.title, '回复二');
});

test('收藏批量删除与 HTML 回填保留其他会话数据', async () => {
  const data = installStorage({
    'kimi-statusbar.bookmarks': {
      sessions: {
        s1: { title: '一', items: { t1: { title: 'A', createdAt: 1 }, t2: { title: 'B', createdAt: 2 } } },
        s2: { title: '二', items: { t3: { title: 'C', createdAt: 3 } } }
      }
    }
  });
  const response = await mutateBookmarks({
    operations: [
      { type: 'patch', sessionId: 's1', turnId: 't1', html: '<p>渲染</p>' },
      { type: 'remove', sessionId: 's1', turnId: 't2' }
    ]
  });
  assert.equal(response.store.sessions.s1.items.t1.html, '<p>渲染</p>');
  assert.equal(response.store.sessions.s1.items.t2, undefined);
  assert.equal(response.store.sessions.s2.items.t3.title, 'C');
  assert.equal(data['kimi-statusbar.bookmarks'].sessions.s2.items.t3.title, 'C');
});

test('收藏存储失败向调用方报错，不伪装成功', async () => {
  installStorage();
  chrome.storage.local.set = async () => { throw new Error('quota exceeded'); };
  await assert.rejects(
    mutateBookmarks({ operations: [upsert('s1', 't1', '回复')] }),
    /quota exceeded/
  );
});
