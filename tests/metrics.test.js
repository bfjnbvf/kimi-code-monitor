const test = require('node:test');
const assert = require('node:assert/strict');

const {
  aggregateSpeed,
  boosterBalanceYuan,
  cacheReadPercentage,
  formatPercentage,
  decodeSpeed,
  defaultWidgetConfig,
  formatTokenCount,
  listDayKeysBetween,
  normalizeUsage,
  normalizeWidgetConfig,
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

test('百分比统一一位小数并向下截断，真实值不足 100 时不显示为 100.0', () => {
  assert.equal(formatPercentage(99.5), '99.5');
  assert.equal(formatPercentage(99.95), '99.9');
  assert.equal(formatPercentage(99.96), '99.9');
  assert.equal(formatPercentage(64.07), '64.0');
  assert.equal(formatPercentage(100), '100.0');
  assert.equal(formatPercentage(-2), '0.0');
  assert.equal(formatPercentage(null), null);
  assert.equal(formatPercentage(undefined), null);
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

test('速度忽略计时精度过低的样本，聚合速度用总输出除以总时长', () => {
  assert.equal(decodeSpeed(24, 1), null);
  assert.equal(decodeSpeed(57, 12), null);
  assert.equal(decodeSpeed(200, 4_000), 50);

  // 聚合口径：单步离群（900 tok/s 级别）不会顶飞显示值
  const samples = [
    { output: 40, outMs: 1_000 },
    { output: 900, outMs: 90 }, // 时长过短，被忽略
    { output: 60, outMs: 1_000 }
  ];
  assert.equal(aggregateSpeed(samples), 50);
  assert.equal(aggregateSpeed([{ output: 0, outMs: 1_000 }]), 0);
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

test('Widget 配置：空输入与垃圾输入都回落到默认配置', () => {
  const defaults = defaultWidgetConfig();
  assert.deepEqual(normalizeWidgetConfig(null), defaults);
  assert.deepEqual(normalizeWidgetConfig(undefined), defaults);
  assert.deepEqual(normalizeWidgetConfig('broken'), defaults);
  assert.deepEqual(normalizeWidgetConfig({ modules: 'nope', orderFull: 42 }), defaults);
});

test('Widget 配置：默认布局（标题行隐藏作备份、宠物沉底置顶、额度沉底）', () => {
  const config = defaultWidgetConfig();
  assert.deepEqual(config.orderFull, ['input', 'cache', 'output', 'speed', 'usageChart']);
  assert.deepEqual(config.orderMini, ['pet', 'quota5h', 'quotaWeek']);
  assert.deepEqual(config.orderHidden, ['header', 'duration', 'agents', 'external']);
  assert.deepEqual(config.modules.header, {
    show: 'hidden', span: 2, showBalance: true, balanceLink: 'subscription'
  });
  // 消耗量默认整宽在完整区末尾；上轮耗时默认整宽隐藏
  assert.equal(config.modules.usageChart.show, 'full');
  assert.equal(config.modules.usageChart.span, 2);
  assert.deepEqual(config.modules.duration, { show: 'hidden', span: 2 });
  assert.deepEqual(config.modules.pet, {
    show: 'mini', span: 2, stat: 'daily', sidebarTidy: true, ballLink: 'none'
  });
});

test('Widget 配置：v1 独立 header 配置迁移为模块', () => {
  const config = normalizeWidgetConfig({
    header: { showInMini: true, showBalance: false, balanceLink: 'console' }
  });
  assert.deepEqual(config.modules.header, {
    show: 'mini', span: 2, showBalance: false, balanceLink: 'console'
  });
  assert.deepEqual(config.orderMini, ['pet', 'quota5h', 'quotaWeek', 'header']);
  assert.deepEqual(config.orderFull, ['input', 'cache', 'output', 'speed', 'usageChart']);
  // 非法迁移值回落默认
  const broken = normalizeWidgetConfig({ header: { showInMini: 'yes', balanceLink: 'https://evil.example' } });
  assert.equal(broken.modules.header.show, 'hidden');
  assert.equal(broken.modules.header.balanceLink, 'subscription');
});

test('Widget 配置：非法字段逐项回落，标题行宽度强制整宽', () => {
  const config = normalizeWidgetConfig({
    modules: {
      header: { show: 'full', span: 1, showBalance: 'yes' },
      input: { show: 'mini', span: 2 },
      speed: { show: 'everywhere', span: 9 },
      usageChart: { show: 'full', chartRange: 'year' }
    }
  });
  assert.equal(config.modules.header.span, 2); // 标题行不接受半宽
  assert.equal(config.modules.header.showBalance, true); // 非 boolean 回落默认
  assert.equal(config.modules.input.show, 'mini');
  assert.equal(config.modules.input.span, 2);
  assert.equal(config.modules.speed.show, 'full'); // 非法状态回落默认
  assert.equal(config.modules.speed.span, 1);
  assert.equal(config.modules.usageChart.chartRange, 'week');
});

test('Widget 配置：子代理模块默认隐藏且强制整宽', () => {
  const defaults = defaultWidgetConfig();
  assert.deepEqual(defaults.modules.agents, { show: 'hidden', span: 2, hiddenAgents: [] });
  const config = normalizeWidgetConfig({
    modules: { agents: { show: 'full', span: 1 } }
  });
  assert.equal(config.modules.agents.span, 2); // 列表模块不接受半宽
  assert.equal(config.modules.agents.show, 'full');
});

test('Widget 配置：order 数组与显隐状态强制一致（含隐藏区）', () => {
  // input 改成 mini 沉底、quota5h 隐藏后，三个区域的 order 各自一致
  const config = normalizeWidgetConfig({
    modules: { input: { show: 'mini', span: 1 }, quota5h: { show: 'hidden' } },
    orderFull: ['header', 'input', 'cache', 'output', 'speed'],
    orderMini: ['quota5h', 'quotaWeek']
  });
  assert.deepEqual(config.orderFull, ['cache', 'output', 'speed', 'usageChart']);
  assert.deepEqual(config.orderMini, ['quotaWeek', 'pet', 'input']);
  assert.deepEqual(config.orderHidden, ['header', 'duration', 'agents', 'external', 'quota5h']);

  // 存储顺序优先于默认顺序；未知 id 被剔除；缺漏的补在末尾
  const reordered = normalizeWidgetConfig({
    orderFull: ['speed', 'output', 'cache', 'input', 'ghost'],
    orderMini: ['quotaWeek', 'quota5h']
  });
  assert.deepEqual(reordered.orderFull, ['speed', 'output', 'cache', 'input', 'usageChart']);
  assert.deepEqual(reordered.orderMini, ['quotaWeek', 'quota5h', 'pet']);
});

test('Widget 配置：额度模块 pace 开关与消耗量统计范围', () => {
  const defaults = defaultWidgetConfig();
  assert.equal(defaults.modules.quota5h.pace, true);
  assert.equal(defaults.modules.quotaWeek.pace, true);

  const config = normalizeWidgetConfig({
    modules: {
      quota5h: { pace: false },
      quotaWeek: { pace: 'yes' },
      usageChart: { chartRange: 'month' }
    }
  });
  assert.equal(config.modules.quota5h.pace, false);
  assert.equal(config.modules.quotaWeek.pace, true); // 非 boolean 回落默认
  assert.equal(config.modules.usageChart.chartRange, 'month');
  // 已下线/未知范围回落默认
  assert.equal(
    normalizeWidgetConfig({ modules: { usageChart: { chartRange: 'curMonth' } } }).modules.usageChart.chartRange,
    'week'
  );
});

test('Widget 配置：v2→v3 迁移把宠物改为全宽，且只迁移一次', () => {
  // 老配置（v2，pet 半宽）→ 迁移为全宽
  const migrated = normalizeWidgetConfig({
    version: 2,
    modules: { pet: { show: 'full', span: 1 } }
  });
  assert.equal(migrated.modules.pet.span, 2);
  assert.equal(migrated.modules.pet.show, 'full'); // show 不动
  // v3 之后的手动半宽设置被尊重
  const manual = normalizeWidgetConfig({
    version: 3,
    modules: { pet: { show: 'full', span: 1 } }
  });
  assert.equal(manual.modules.pet.span, 1);
  // 无 version 的旧存储也按 v2 迁移
  assert.equal(normalizeWidgetConfig({ modules: { pet: { span: 1 } } }).modules.pet.span, 2);
});

test('Widget 配置：宠物右侧数据选项与侧栏改造开关归一化', () => {
  assert.equal(normalizeWidgetConfig({ modules: { pet: { stat: 'balance' } } }).modules.pet.stat, 'balance');
  // 非法值回落默认 daily
  assert.equal(normalizeWidgetConfig({ modules: { pet: { stat: 'weekly' } } }).modules.pet.stat, 'daily');
  // 侧栏改造：非 boolean 回落默认 true，显式 false 保留
  assert.equal(normalizeWidgetConfig({ modules: { pet: { sidebarTidy: 'no' } } }).modules.pet.sidebarTidy, true);
  assert.equal(normalizeWidgetConfig({ modules: { pet: { sidebarTidy: false } } }).modules.pet.sidebarTidy, false);
  // 小球跳转：非法值回落 none
  assert.equal(normalizeWidgetConfig({ modules: { pet: { ballLink: 'console' } } }).modules.pet.ballLink, 'console');
  assert.equal(normalizeWidgetConfig({ modules: { pet: { ballLink: 'xxx' } } }).modules.pet.ballLink, 'none');
});
