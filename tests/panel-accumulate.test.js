// accumulate.js 单元测试：按天自积累（localStorage 桩）+ 与安装器文件的按天取大合并。
// 模块级内存缓存靠 resetAccumulatedCache() 复位，用例之间不共享状态。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import {
  noteStepUsage,
  mergeDaily,
  hasAccumulated,
  resetAccumulatedCache
} from '../src/panel-app/accumulate.js';

function freshStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k)
  };
  resetAccumulatedCache();
  return map;
}

// 用例可能挂起 2s 写盘防抖，收尾统一清掉，避免进程多等
after(() => resetAccumulatedCache());

test('noteStepUsage：增量入今日桶，input 记全部输入（与文件扫描同口径）', () => {
  freshStorage();
  // 归一化后的两种入参形态：扩展侧 inputTokens，wire 侧 inputOther
  noteStepUsage({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 50 });
  noteStepUsage({ inputOther: 30, output: 5, inputCacheRead: 20, inputCacheCreation: 4 });
  const merged = mergeDaily({});
  const today = Object.keys(merged)[0];
  assert.equal(Object.keys(merged).length, 1);
  // input = 100+50（含缓存读）+ 30+20+4（含缓存读与缓存创建）；cacheRead 单列
  assert.deepEqual(merged[today], { input: 204, output: 15, cacheRead: 70 });
  assert.ok(hasAccumulated());
});

test('noteStepUsage：全零记录不留空桶', () => {
  freshStorage();
  noteStepUsage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
  noteStepUsage(null);
  assert.equal(hasAccumulated(), false);
  assert.deepEqual(mergeDaily({}), {});
});

test('回归：积累桶与文件桶同口径，缓存命中率不会超过 100%', () => {
  freshStorage();
  // 非缓存 1000 + 缓存读 5000：v1 口径下 input 只记 1000，图表会算出 500%
  noteStepUsage({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000 });
  const bucket = mergeDaily({})[Object.keys(mergeDaily({}))[0]];
  assert.equal(bucket.input, 6000);
  assert.ok(bucket.cacheRead / bucket.input <= 1, '缓存命中率不应越界');
});

test('mergeDaily：文件缺席的天由积累补，冲突的天取大者', () => {
  freshStorage();
  noteStepUsage({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 50 }); // 今日 150
  const today = Object.keys(mergeDaily({}))[0];
  const file = {
    '2026-09-01': { input: 1000, output: 100, cacheRead: 500 }, // 文件独有
    [today]: { input: 5000, output: 200, cacheRead: 1000 }      // 比积累大 → 文件赢
  };
  const merged = mergeDaily(file);
  assert.deepEqual(merged['2026-09-01'], file['2026-09-01']); // 积累没有 → 文件补上
  assert.equal(merged[today].input, 5000);                    // 文件更大 → 文件赢
  const merged2 = mergeDaily({ [today]: { input: 1, output: 0, cacheRead: 0 } });
  assert.equal(merged2[today].input, 150);                    // 积累更大 → 积累赢
});

test('mergeDaily：文件侧脏数据不引入（null / 非对象桶）', () => {
  freshStorage();
  assert.deepEqual(mergeDaily(null), {});
  assert.deepEqual(mergeDaily({ 'bad-day': null }), {});
  assert.deepEqual(mergeDaily({ 'bad-day': 'nope' }), {});
});

test('迁移：v1 桶（input 只含非缓存）按 cacheRead 补齐后读入 v2', () => {
  freshStorage({ 'kcm.daily.v1': JSON.stringify({ '2026-09-01': { input: 100, output: 10, cacheRead: 900 } }) });
  const merged = mergeDaily({});
  assert.deepEqual(merged['2026-09-01'], { input: 1000, output: 10, cacheRead: 900 });
});
