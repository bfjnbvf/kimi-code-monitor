// 消息来源守卫（src/background/sender-guard.js）：
// 扩展自有页面（popup 无 tab / 选项页带 tab）按自身扩展 ID 的 URL 前缀全量放行；
// 内容脚本仅放行「回环 / 已动态授权 origin」来源，且消息类型限于内容脚本
// 实际使用的白名单——特权消息一律拒绝。
import test from 'node:test';
import assert from 'node:assert/strict';

const storage = new Map();
globalThis.chrome = {
  runtime: { id: 'test-ext-id' },
  storage: {
    local: {
      get: async (key) => ({ [key]: storage.get(key) }),
      set: async (obj) => {
        for (const [k, v] of Object.entries(obj)) storage.set(k, v);
      },
      remove: async (key) => {
        storage.delete(key);
      }
    }
  }
};

const { authorizeMessage } = await import('../src/background/sender-guard.js');

// runtime.MessageSender 的真实形状：frame URL 在顶层 sender.url，
// sender.tab 是所在标签页（其 url 需扩展权限才可见，守卫不依赖它）
const contentSender = (url) => ({ url, tab: { id: 1, url } });

test('扩展自有页面：popup（无 tab）与选项页标签（带 tab + 自身 chrome-extension URL）全量放行', async () => {
  assert.equal(await authorizeMessage('accounts.remove', {}), true);
  assert.equal(await authorizeMessage('external.add', undefined), true);
  assert.equal(
    await authorizeMessage('cli.usage.status', { url: 'chrome-extension://test-ext-id/popup.html' }),
    true
  );
  // 选项页以标签页打开：sender 带 tab，URL 是自身扩展 ID 前缀——必须放行
  // （回归：曾按「有没有 tab」判定，把选项页误判为内容脚本全部拒绝）
  assert.equal(
    await authorizeMessage(
      'cli.usage.status',
      { url: 'chrome-extension://test-ext-id/popup.html', tab: { id: 9, index: 2 } }
    ),
    true
  );
  assert.equal(
    await authorizeMessage(
      'accounts.remove',
      { url: 'chrome-extension://test-ext-id/popup.html', tab: { id: 9 } }
    ),
    true
  );
});

test('他方扩展页面的消息（URL 前缀不是自身 ID）按不可信处理', async () => {
  const sender = {
    url: 'chrome-extension://other-ext-id/popup.html',
    tab: { id: 9 }
  };
  assert.equal(await authorizeMessage('quota.fetch', sender), false);
  assert.equal(await authorizeMessage('accounts.remove', sender), false);
});

test('回环来源的内容脚本：白名单消息放行，特权消息拒绝', async () => {
  const sender = contentSender('http://127.0.0.1:3000/sessions/s1');
  assert.equal(await authorizeMessage('quota.fetch', sender), true);
  assert.equal(await authorizeMessage('oauth.start', sender), true);
  assert.equal(await authorizeMessage('cli.usage.refresh', sender), true);
  assert.equal(await authorizeMessage('pet.asset.active', sender), true);
  assert.equal(await authorizeMessage('webtoken.report', sender), true);
  // v2 起命名走系统「生成标题」，rename.model 已移出白名单
  assert.equal(await authorizeMessage('rename.model', sender), false);

  assert.equal(await authorizeMessage('accounts.switch', sender), false);
  assert.equal(await authorizeMessage('accounts.remove', sender), false);
  assert.equal(await authorizeMessage('oauth.reset', sender), false);
  assert.equal(await authorizeMessage('auth.clear', sender), false);
  assert.equal(await authorizeMessage('external.add', sender), false);
  assert.equal(await authorizeMessage('hosts.grant', sender), false);
  assert.equal(await authorizeMessage('hosts.revoke', sender), false);
  assert.equal(await authorizeMessage('cli.usage.disconnect', sender), false);
});

test('已动态授权 origin 的内容脚本放行白名单消息', async () => {
  storage.set('kimiExtraWebHosts', ['http://192.168.1.5:3000/*']);
  const sender = contentSender('http://192.168.1.5:3000/sessions/s1');
  assert.equal(await authorizeMessage('quota.fetch', sender), true);
  assert.equal(await authorizeMessage('accounts.remove', sender), false);
});

test('未授权 origin 的内容脚本一律拒绝', async () => {
  for (const url of [
    'http://192.168.1.5:3001/sessions/s1',
    'https://evil.example.com/',
    'http://127.0.0.1.evil.com/'
  ]) {
    const sender = contentSender(url);
    assert.equal(await authorizeMessage('quota.fetch', sender), false, url);
    assert.equal(await authorizeMessage('accounts.remove', sender), false, url);
  }
});

test('sender.url 缺失或非法按不可信处理', async () => {
  assert.equal(await authorizeMessage('quota.fetch', { tab: { id: 1 } }), false);
  assert.equal(await authorizeMessage('quota.fetch', contentSender('not a url')), false);
  assert.equal(await authorizeMessage('quota.fetch', contentSender(undefined)), false);
});
