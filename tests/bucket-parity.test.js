// 口径一致性护栏：同一条 usage 记录，网页版扫描路径（cli-usage.parseUsageLines）
// 与客户端页内积累路径（accumulate.noteStepUsage）必须产出同一个桶。
//
// 背景：两边各写一份「按天桶怎么算」曾经真的漂移过——积累侧只把非缓存输入
// 记进 input（缓存读/缓存创建另算），文件扫描侧记全部输入，于是「按天取大」
// 变成两种口径互相压制，图表缓存命中率算出 500%。现在口径单点在
// metrics.emptyUsageBucket / addUsageToBucket，这条测试守着它不被拆回去。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { parseUsageLines } from '../src/cli-usage.js';
import { normalizeUsage } from '../src/metrics.js';
import { noteStepUsage, mergeDaily, resetAccumulatedCache } from '../src/panel-app/accumulate.js';

// noteStepUsage 会挂一个 2s 写盘防抖，收尾清掉免得拖慢整轮测试
after(() => resetAccumulatedCache());

/** wire.jsonl 里一条 usage.record 的原始形状 */
function wireLine(usage, time) {
  return JSON.stringify({ type: 'usage.record', model: 'kimi-code/test', usage, usageScope: 'turn', time });
}

const RECORDS = [
  { inputOther: 120, inputCacheRead: 800, inputCacheCreation: 80, output: 30 },
  { inputOther: 0, inputCacheRead: 500, inputCacheCreation: 0, output: 12 }
];

test('同一条记录：网页版扫描与客户端积累产出同一个桶', () => {
  const now = Date.now();

  // 网页版路径：background 扫描 wire.jsonl
  const webDaily = {};
  parseUsageLines(RECORDS.map((usage) => wireLine(usage, now)).join('\n'), webDaily);

  // 客户端路径：bridge.js 把 normalizeUsage 的结果交给 noteStepUsage
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {}
  };
  resetAccumulatedCache();
  for (const usage of RECORDS) noteStepUsage(normalizeUsage(usage));
  const clientDaily = mergeDaily({});

  assert.deepEqual(clientDaily, webDaily);
  // 数值也钉死：input = 全部输入（非缓存 + 缓存读 + 缓存创建）
  const [bucket] = Object.values(clientDaily);
  assert.deepEqual(bucket, { input: 1500, output: 42, cacheRead: 1300 });
});

test('两天各一条：两条路径的按天分桶同样一致', () => {
  const day = 24 * 3_600_000;
  const now = Date.now();

  // 网页版：跨天记录按 record.time 落到各自的自然日
  const webDaily = {};
  parseUsageLines([
    wireLine(RECORDS[0], now),
    wireLine(RECORDS[1], now - day)
  ].join('\n'), webDaily);
  assert.equal(Object.keys(webDaily).length, 2);

  // 客户端：noteStepUsage 只进「今日桶」，昨天那条等价于文件侧已有数据，
  // 因此这里只比对今日桶（跨天补齐由 usageDaily 文件侧负责，见 mergeDaily 注释）
  globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  resetAccumulatedCache();
  noteStepUsage(normalizeUsage(RECORDS[0]));
  const clientToday = mergeDaily({});
  const todayKey = Object.keys(clientToday)[0];
  assert.deepEqual(clientToday[todayKey], webDaily[todayKey]);
});
