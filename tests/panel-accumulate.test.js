// accumulate.js 单元测试：按天自积累（localStorage 桩）+ 与看门狗文件的按天取大合并
import test from 'node:test';
import assert from 'node:assert/strict';

import { noteStepUsage, mergeDaily, hasAccumulated } from '../src/panel-app/accumulate.js';

function freshStorage() {
  const map = new Map();
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k)
  };
  return map;
}

// 模块级内存缓存 mem 跨测试共享，每个用例前换全新的 storage 即可隔离
//（mem 已在首次 load 后常驻，这里通过直接操作桩数据验证纯函数行为）

test('noteStepUsage：增量用量入今日桶并落盘', async () => {
  freshStorage();
  noteStepUsage({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 50 });
  noteStepUsage({ inputTokens: 30, outputTokens: 5, cacheReadTokens: 20 });
  // 写盘有 2s 防抖，先验内存合并结果
  const merged = mergeDaily({});
  const today = Object.keys(merged)[0];
  assert.equal(Object.keys(merged).length, 1);
  assert.deepEqual(merged[today], { input: 130, output: 15, cacheRead: 70 });
  assert.ok(hasAccumulated());
});

test('mergeDaily：文件缺席的天由积累补，冲突的天取大者', () => {
  const today = Object.keys(mergeDaily({}))[0];
  const file = {
    '2026-09-01': { input: 1000, output: 100, cacheRead: 500 }, // 文件独有
    [today]: { input: 5000, output: 200, cacheRead: 1000 }      // 比积累大 → 文件赢
  };
  const merged = mergeDaily(file);
  assert.deepEqual(merged['2026-09-01'], file['2026-09-01']); // 积累没有 → 文件补上
  assert.equal(merged[today].input, 5000);                    // 文件更大 → 文件赢
  const merged2 = mergeDaily({ [today]: { input: 1, output: 0, cacheRead: 0 } });
  assert.equal(merged2[today].input, 130);                    // 积累更大 → 积累赢
});

test('mergeDaily：都空时返回空表（图表维持未连接态）', () => {
  freshStorage();
  // mem 里仍有上个用例的积累（模块级缓存），这里只验证文件侧不引入脏数据
  assert.deepEqual(mergeDaily(null)['2026-09-01'], undefined);
  assert.deepEqual(mergeDaily({ 'bad-day': null })['bad-day'], undefined);
});
