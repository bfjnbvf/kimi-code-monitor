// 外部账户「失败沿用上次成功值」：扩展侧（background/external.js）与桌面补丁
// （panel-app/direct.js 的 lastGood）同一语义——余额接口失败时面板显示
// 「N 分钟前 ¥旧值」而不是「获取失败」；成功后带 fetchedAt 自动恢复。
// 这里用 mock chrome + mock fetch 直接驱动扩展侧实现验证。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIndexedDBMock } from './background-test-helper.js';

function memoryChrome() {
  const data = {};
  return {
    indexedDB: createIndexedDBMock(),
    storage: {
      local: {
        async get(keys) {
          if (keys == null) return { ...data };
          const list = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(list.filter((key) => key in data).map((key) => [key, data[key]]));
        },
        async set(values) { Object.assign(data, values); },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
        }
      }
    },
    permissions: { async contains() { return true; } }
  };
}

/** 可编排的 fetch mock：依次消费队列，空了就抛错。 */
function fetchMock(responses) {
  const queue = [...responses];
  return async () => {
    if (!queue.length) throw new Error('HTTP 503');
    const body = queue.shift();
    return { ok: true, status: 200, json: async () => body };
  };
}

const DEEPSEEK_OK = { balance_infos: [{ currency: 'CNY', total_balance: '6.7', granted_balance: '1', topped_up_balance: '5.7' }] };

test('外部账户：接口失败沿用上次成功值（fetchedAt 保留），成功后恢复并更新时间', async () => {
  globalThis.chrome = memoryChrome();
  globalThis.indexedDB = createIndexedDBMock(); // vault 的密钥库走裸全局 indexedDB
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock([DEEPSEEK_OK]);
  try {
    const external = await import('../src/background/external.js');
    await external.addExternalAccount({ provider: 'deepseek', key: 'sk-test-0b71' });

    // 第一轮：成功，数值与时间落缓存
    const first = await external.getExternalProvidersStatus();
    assert.equal(first.providers[0].error, '');
    assert.equal(first.providers[0].total, 6.7);
    const fetchedAt = first.providers[0].fetchedAt;
    assert.ok(Number.isFinite(fetchedAt), '成功结果应带 fetchedAt');

    // 时间推过 TTL（60s），接口开始 503：沿用旧值，不显示「获取失败」
    const second = await external.getExternalProvidersStatus({ now: fetchedAt + 61_000 });
    assert.equal(second.providers[0].error, 'HTTP 503');
    assert.equal(second.providers[0].total, 6.7, '应沿用上次成功的数值');
    assert.equal(second.providers[0].fetchedAt, fetchedAt, '数字年龄应指向成功那轮');

    // 再推过 TTL，接口恢复：数值更新，error 清空
    globalThis.fetch = fetchMock([{ balance_infos: [{ currency: 'CNY', total_balance: '5.2', granted_balance: '1', topped_up_balance: '4.2' }] }]);
    const third = await external.getExternalProvidersStatus({ now: fetchedAt + 122_000 });
    assert.equal(third.providers[0].error, '');
    assert.equal(third.providers[0].total, 5.2);
    assert.ok(third.providers[0].fetchedAt > fetchedAt, '恢复后 fetchedAt 应更新');
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.chrome;
    delete globalThis.indexedDB;
  }
});
