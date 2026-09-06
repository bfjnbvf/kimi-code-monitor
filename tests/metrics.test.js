import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateSpeed,
  boosterBalanceYuan,
  buildHeatmapData,
  cacheReadPercentage,
  formatPercentage,
  decodeSpeed,
  defaultWidgetConfig,
  formatTokenCount,
  listDayKeysBetween,
  normalizeUsage,
  normalizeWidgetConfig,
  pruneDailyUsage,
  pruneHourlyUsage,
  sumUsageBetween,
  totalInputTokens,
  usageDayKey,
  usageHourKey
} from '../src/metrics.js';

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

test('日期键按本地自然日且可字符串比较，修剪只保留近期桶', () => {
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

test('日期键以本地午夜为界，跨 DST 也稳定', () => {
  // 本地午夜前后分属相邻两天（用本地分量构造，任何时区运行结果一致）
  assert.equal(usageDayKey(new Date(2026, 6, 15, 23, 30)), '2026-07-15');
  assert.equal(usageDayKey(new Date(2026, 6, 16, 0, 30)), '2026-07-16');

  // 美国东部夏令时 2026-03-08 02:00 是 DST 跳变点，本地日期键仍落在当天
  assert.equal(usageDayKey(new Date(2026, 2, 8, 3, 30)), '2026-03-08');
});

test('小时键按本地小时，修剪只保留近两天', () => {
  const now = new Date(2026, 6, 30, 15, 0);
  assert.equal(usageHourKey(now), '2026-07-30T15');

  const hourly = {
    '2026-07-30T09': { input: 1, output: 1, cacheRead: 0 },
    '2026-07-29T23': { input: 1, output: 1, cacheRead: 0 },
    '2026-07-28T23': { input: 1, output: 1, cacheRead: 0 }
  };
  const pruned = pruneHourlyUsage(hourly, 2, now);
  assert.deepEqual(Object.keys(pruned), ['2026-07-30T09', '2026-07-29T23']);
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
  assert.deepEqual(config.orderHidden, ['header', 'duration', 'external', 'agents']);
  assert.deepEqual(config.modules.header, {
    show: 'hidden', span: 2, showBalance: true, balanceLink: 'subscription'
  });
  // 消耗量默认整宽在完整区末尾；上轮耗时/外部账户默认半宽隐藏（同行相邻）
  assert.equal(config.modules.usageChart.show, 'full');
  assert.equal(config.modules.usageChart.span, 2);
  assert.deepEqual(config.modules.duration, { show: 'hidden', span: 1 });
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
  assert.deepEqual(config.orderHidden, ['header', 'duration', 'external', 'agents', 'quota5h']);

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

test('Widget 配置：额度模块重置时间显示格式（倒计时/具体时间）', () => {
  const defaults = defaultWidgetConfig();
  assert.equal(defaults.modules.quota5h.resetFormat, 'countdown');
  assert.equal(defaults.modules.quotaWeek.resetFormat, 'countdown');

  const config = normalizeWidgetConfig({
    modules: {
      quota5h: { resetFormat: 'absolute' },
      quotaWeek: { resetFormat: 'timestamp' }
    }
  });
  assert.equal(config.modules.quota5h.resetFormat, 'absolute');
  assert.equal(config.modules.quotaWeek.resetFormat, 'countdown'); // 非法值回落默认
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

test('Widget 配置：order 数组含重复 id 时去重，缺漏仍补在末尾', () => {
  // 用户手动改坏 storage 可能留下重复 id，归一化后每个模块只出现一次
  const config = normalizeWidgetConfig({
    orderFull: ['speed', 'speed', 'output', 'cache', 'input', 'input'],
    orderMini: ['pet', 'pet', 'quota5h']
  });
  assert.deepEqual(config.orderFull, ['speed', 'output', 'cache', 'input', 'usageChart']);
  assert.deepEqual(config.orderMini, ['pet', 'quota5h', 'quotaWeek']);
});


test('buildHeatmapData：周列周一起头、首尾截断，level 按 maxTotal 比例分档', () => {
  // 2026-08-03 是周一；14 天窗口：2026-07-21（周二）.. 2026-08-03（周一）
  const daily = {
    '2026-08-03': { input: 80, output: 20, cacheRead: 0 },
    '2026-08-02': { input: 10, output: 10, cacheRead: 0 },
    '2026-08-01': { input: 40, output: 0, cacheRead: 0 },
    '2026-07-31': { input: 60, output: 0, cacheRead: 0 },
    '2026-07-30': { input: 90, output: 0, cacheRead: 0 }
  };
  const { weeks, maxTotal, thresholds } = buildHeatmapData(daily, '2026-08-03', 14);
  assert.equal(maxTotal, 100);
  assert.deepEqual(thresholds, [20, 40, 60, 80]);
  // 首列周二起（6 格）、中间整周（7 格）、末列只有周一（1 格）
  assert.deepEqual(weeks.map((w) => w.length), [6, 7, 1]);
  assert.equal(weeks[0][0].key, '2026-07-21');
  assert.equal(weeks[1][0].key, '2026-07-27');
  assert.equal(weeks[2][0].key, '2026-08-03');
  const byKey = Object.fromEntries(weeks.flat().map((c) => [c.key, c]));
  assert.equal(byKey['2026-07-21'].total, 0);
  assert.equal(byKey['2026-07-21'].level, 0);
  assert.equal(byKey['2026-08-02'].level, 1); // 20 <= t1
  assert.equal(byKey['2026-08-01'].level, 2); // 40 <= t2
  assert.equal(byKey['2026-07-31'].level, 3); // 60 <= t3
  assert.equal(byKey['2026-07-30'].level, 4); // 90 > t3
  assert.equal(byKey['2026-08-03'].level, 4); // 100 > t3
});

test('buildHeatmapData：空数据阈值全 0、level 恒 0；默认窗口 90 天', () => {
  const empty = buildHeatmapData({}, '2026-08-03', 7);
  assert.equal(empty.maxTotal, 0);
  assert.deepEqual(empty.thresholds, [0, 0, 0, 0]);
  assert.equal(empty.weeks.flat().length, 7);
  assert.ok(empty.weeks.flat().every((c) => c.total === 0 && c.level === 0));
  // dayCount 缺省对齐 90 天保留期
  assert.equal(buildHeatmapData({}, '2026-08-03').weeks.flat().length, 90);
});
