// Remote Control（kimi rc）适配：/devices/<id>/ 前缀与空凭据处理。
// utils.js 的这些函数读 location，用全局 stub 模拟不同页面路径。
import test from 'node:test';
import assert from 'node:assert/strict';

const { rcApiPrefix, isRemoteControl, localApiAuthHeaders } = await import('../src/content/utils.js');

function withPathname(pathname, fn) {
  const prev = globalThis.location;
  globalThis.location = { pathname };
  try {
    fn();
  } finally {
    globalThis.location = prev;
  }
}

test('RC 页面路径解析出 /devices/<id> 前缀', () => {
  withPathname('/devices/7f7f66f9-78a4-4591-9f97-5d5249b808d9/sessions/s1', () => {
    assert.equal(rcApiPrefix(), '/devices/7f7f66f9-78a4-4591-9f97-5d5249b808d9');
    assert.equal(isRemoteControl(), true);
  });
  withPathname('/devices/abc/', () => {
    assert.equal(rcApiPrefix(), '/devices/abc');
  });
});

test('本机/LAN 直连路径前缀为空', () => {
  for (const pathname of ['/sessions/s1', '/', '/settings']) {
    withPathname(pathname, () => {
      assert.equal(rcApiPrefix(), '');
      assert.equal(isRemoteControl(), false);
    });
  }
});

test('空凭据省略 Authorization 头（RC 由中继注入 token）', () => {
  assert.deepEqual(localApiAuthHeaders(''), {});
  assert.deepEqual(localApiAuthHeaders(undefined), {});
  assert.deepEqual(localApiAuthHeaders('tok-123'), { Authorization: 'Bearer tok-123' });
});
