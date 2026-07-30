const test = require('node:test');
const assert = require('node:assert/strict');

const {
  accumulateDailyUsage,
  appendSpeedSample,
  boosterBalanceYuan,
  cacheReadPercentage,
  decodeSpeed,
  formatTokenCount,
  listDayKeysBetween,
  medianSpeed,
  normalizeUsage,
  pruneDailyUsage,
  sumUsageBetween,
  totalInputTokens,
  usageDayKey
} = require('../metrics.js');

test('总输入包含未缓存、缓存读取和缓存创建 token', () => {
  const usage = normalizeUsage({
    inputOther: 120,
    output: 30,
    inputCacheRead: 800,
    inputCacheCreation: 80
  });

  assert.deepEqual(usage, {
    inputTokens: 120,
    outputTokens: 30,
    cacheReadTokens: 800,
    cacheCreationTokens: 80
  });
  assert.equal(totalInputTokens(usage), 1_000);
  assert.equal(cacheReadPercentage(usage), 80);
});

test('快照和 OpenAI 风格字段使用同一归一化逻辑', () => {
  assert.deepEqual(normalizeUsage({
    input_tokens: '10',
    output_tokens: 2,
    cache_read_tokens: 20,
    cache_creation_tokens: 5
  }), {
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 20,
    cacheCreationTokens: 5
  });

  assert.deepEqual(normalizeUsage({ prompt_tokens: 9, completion_tokens: 3 }), {
    inputTokens: 9,
    outputTokens: 3,
    cacheReadTokens: 0,
    cacheCreationTokens: 0
  });
});

test('无效或负数 token 不会污染累计值', () => {
  assert.deepEqual(normalizeUsage({
    input_tokens: -1,
    output_tokens: null,
    cache_read_tokens: 'invalid',
    cache_creation_tokens: Infinity
  }), {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0
  });
});

test('缓存分母为零时不生成百分比', () => {
  assert.equal(cacheReadPercentage(normalizeUsage({})), null);
});

test('速度忽略计时精度过低的样本，并使用最近五次中位数', () => {
  assert.equal(decodeSpeed(24, 1), null);
  assert.equal(decodeSpeed(57, 12), null);
  assert.equal(decodeSpeed(200, 4_000), 50);

  let samples = [];
  for (const speed of [40, 42, 41, 900, 43, 44]) {
    samples = appendSpeedSample(samples, speed);
  }
  assert.deepEqual(samples, [42, 41, 900, 43, 44]);
  assert.equal(medianSpeed(samples), 43);
});

test('钱包未启用时不展示接口中的伪余额', () => {
  assert.equal(boosterBalanceYuan(null), null);
  assert.equal(boosterBalanceYuan({
    status: 'STATUS_DISABLED',
    balance: { amountLeft: '7500000000' }
  }), 0);
  assert.equal(boosterBalanceYuan({
    status: 'STATUS_ACTIVE',
    balance: { amountLeft: '315250700' }
  }), 3.152507);
});

test('按天累计：输入含缓存读写，命中率口径与 widget 一致', () => {
  const usage = normalizeUsage({
    inputOther: 120,
    output: 30,
    inputCacheRead: 800,
    inputCacheCreation: 80
  });
  let daily = accumulateDailyUsage(null, '2026-07-30', usage);
  daily = accumulateDailyUsage(daily, '2026-07-30', usage);
  daily = accumulateDailyUsage(daily, '2026-07-29', usage);

  assert.deepEqual(daily['2026-07-30'], { input: 2_000, output: 60, cacheRead: 1_600 });
  assert.deepEqual(daily['2026-07-29'], { input: 1_000, output: 30, cacheRead: 800 });
});

test('子代理消耗同额累加进 sub 子桶，主代理事件不产生 sub', () => {
  const usage = normalizeUsage({ inputOther: 100, output: 10, inputCacheRead: 900 });
  let daily = accumulateDailyUsage(null, '2026-07-30', usage, false);
  assert.equal(daily['2026-07-30'].sub, undefined);

  daily = accumulateDailyUsage(daily, '2026-07-30', usage, true);
  daily = accumulateDailyUsage(daily, '2026-07-30', usage, true);
  assert.deepEqual(daily['2026-07-30'], {
    input: 3_000,
    output: 30,
    cacheRead: 2_700,
    sub: { input: 2_000, output: 20, cacheRead: 1_800 }
  });
});

test('日期键使用本地时区且可字符串比较，修剪只保留近期桶', () => {
  const now = new Date('2026-07-30T15:00:00');
  assert.equal(usageDayKey(now), '2026-07-30');

  const daily = {
    '2026-07-30': { input: 1, output: 1, cacheRead: 0 },
    '2026-06-15': { input: 1, output: 1, cacheRead: 0 },
    '2026-01-01': { input: 1, output: 1, cacheRead: 0 }
  };
  const pruned = pruneDailyUsage(daily, 30, now);
  assert.deepEqual(Object.keys(pruned), ['2026-07-30']);
});

test('token 数量缩写与 widget 一致', () => {
  assert.equal(formatTokenCount(0), '0');
  assert.equal(formatTokenCount(999), '999');
  assert.equal(formatTokenCount(1_000), '1k');
  assert.equal(formatTokenCount(186_200), '186.2k');
  assert.equal(formatTokenCount(1_200_000), '1.2M');
  assert.equal(formatTokenCount(-5), '0');
});

test('任意日期范围求和：含端点，范围外不计', () => {
  const daily = {
    '2026-07-01': { input: 1_000, output: 100, cacheRead: 500 },
    '2026-07-15': { input: 2_000, output: 200, cacheRead: 1_000 },
    '2026-07-30': { input: 4_000, output: 400, cacheRead: 2_000 }
  };
  const sum = sumUsageBetween(daily, '2026-07-15', '2026-07-30');
  assert.equal(sum.totalTokens, 6_600);
  assert.equal(sum.cacheHitRate, 0.5);

  assert.equal(sumUsageBetween(daily, null, null).totalTokens, 7_700);
  assert.equal(sumUsageBetween(daily, '2026-08-01', '2026-08-31').cacheHitRate, null);
});

test('枚举日期范围覆盖每个自然日（含空白天）', () => {
  assert.deepEqual(listDayKeysBetween('2026-07-28', '2026-07-30'), [
    '2026-07-28',
    '2026-07-29',
    '2026-07-30'
  ]);
  assert.deepEqual(listDayKeysBetween('2026-02-27', '2026-03-01'), [
    '2026-02-27',
    '2026-02-28',
    '2026-03-01'
  ]);
  assert.deepEqual(listDayKeysBetween('2026-07-30', '2026-07-30'), ['2026-07-30']);
});
