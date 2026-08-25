import test from 'node:test';
import assert from 'node:assert/strict';
import { buildShareCardSvg, buildBarSeries, CARD_WIDTH, CARD_HEIGHT } from '../src/share-card.js';

const FIXTURE = {
  '2026-08-20': { input: 1_000_000, output: 100_000, cacheRead: 600_000 },
  '2026-08-21': {
    input: 2_000_000,
    output: 200_000,
    cacheRead: 1_000_000,
    sub: { input: 400_000, output: 50_000, cacheRead: 0 }
  },
  '2026-08-22': { input: 500_000, output: 40_000, cacheRead: 0 }
};

test('卡片 SVG：固定画布，页眉含标题与日期范围', () => {
  const svg = buildShareCardSvg({
    daily: FIXTURE,
    startKey: '2026-08-20',
    endKey: '2026-08-22'
  });
  assert.match(svg, new RegExp(`width="${CARD_WIDTH}" height="${CARD_HEIGHT}"`));
  assert.match(svg, /Kimi Code 用量/);
  assert.match(svg, /2026\.08\.20 – 2026\.08\.22/);
});

test('四张统计卡：输入/输出/缓存命中/总消耗，各带渐变折线', () => {
  const svg = buildShareCardSvg({ daily: FIXTURE, startKey: '2026-08-20', endKey: '2026-08-22' });
  // 输入 3.5M / 输出 340k / 缓存命中 (600k+1000k)/3500k = 45.7% / 总消耗 3.8M
  for (const label of ['输入', '输出', '缓存命中', '总消耗']) {
    assert.match(svg, new RegExp(`>${label}<`));
  }
  assert.match(svg, />3\.5M</);
  assert.match(svg, />340k</);
  assert.match(svg, />45\.7%</);
  assert.match(svg, />3\.8M</);
  // 渐变面积折线：linearGradient + polyline + 末端圆点
  assert.match(svg, /<linearGradient id="sc-fade-/);
  assert.match(svg, /<polyline/);
});

test('主图堆叠柱：主蓝子绿，头部右上为大字总量（缓存命中不重复），峰值有图注', () => {
  const svg = buildShareCardSvg({ daily: FIXTURE, startKey: '2026-08-20', endKey: '2026-08-22' });
  assert.match(svg, /每日消耗/);
  assert.doesNotMatch(svg, /每周消耗/);
  // 缓存命中在上方统计卡已有，柱图头部不再重复（统计卡只显示 45.7% 数值）
  assert.doesNotMatch(svg, /缓存命中 45\.7%/);
  assert.match(svg, /#16c456/);
  assert.match(svg, /峰值 08\.21 · 2\.2M/);
});

test('范围汇总：活跃天数/日均/主子代理/峰值日，数值两位小数', () => {
  const svg = buildShareCardSvg({ daily: FIXTURE, startKey: '2026-08-20', endKey: '2026-08-22' });
  assert.match(svg, /活跃天数/);
  assert.match(svg, /3 \/ 3 天/);
  assert.match(svg, /1\.28M \/ 天/);
  assert.match(svg, /主代理/);
  assert.match(svg, /3\.39M/);
  assert.match(svg, /子代理/);
  assert.match(svg, /450\.00k/);
  assert.match(svg, /08\.21 · 2\.20M/);
  // 无子代理数据时显示 --
  const plain = buildShareCardSvg({
    daily: { '2026-08-20': FIXTURE['2026-08-20'] },
    startKey: '2026-08-20',
    endKey: '2026-08-20'
  });
  assert.match(plain, /子代理<\/text>\s*<text[^>]*>--<\/text>/);
});

test('热力图：跟随所选日期范围，范围不同格子数不同；活跃天数只在范围汇总出现', () => {
  const short = buildShareCardSvg({ daily: FIXTURE, startKey: '2026-08-20', endKey: '2026-08-22' });
  assert.match(short, /活跃热力图 · 3 天/);
  // 热力图卡片头部不再重复计数（范围汇总里的「3 / 3 天」是另一格式）
  assert.doesNotMatch(short, />活跃 \d+ 天</);
  const daily = { ...FIXTURE };
  for (let i = 30; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(2026, 7, 22));
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    if (!daily[key]) daily[key] = { input: 1000, output: 100, cacheRead: 0 };
  }
  const long = buildShareCardSvg({ daily, startKey: '2026-07-24', endKey: '2026-08-22' });
  assert.match(long, /活跃热力图 · 30 天/);
});

test('每日消耗：纵轴横网格线按 25/50/75/100% 等距，数值标在线左端', () => {
  // FIXTURE 峰值 2.2M → 网格标签 550k / 1.1M / 2.2M
  const svg = buildShareCardSvg({ daily: FIXTURE, startKey: '2026-08-20', endKey: '2026-08-22' });
  assert.match(svg, />550k</);
  assert.match(svg, />1\.1M</);
  assert.match(svg, />2\.2M</);
});

test('任意天数一律按天出柱，输入/输出/缓存小计与柱图同源守恒', () => {
  const daily = {};
  const days = 90;
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(2026, 7, 23));
    d.setUTCDate(d.getUTCDate() - i);
    daily[d.toISOString().slice(0, 10)] = { input: 1000, output: 100, cacheRead: 500 };
  }
  const keys = Object.keys(daily).sort();
  const series = buildBarSeries(daily, keys[0], keys[keys.length - 1]);
  assert.equal(series.granularity, 'day');
  assert.equal(series.items.length, days);
  // 总量/缓存小计守恒（统计卡折线与柱图同源）
  assert.equal(series.items.reduce((acc, item) => acc + item.total, 0), days * 1100);
  assert.equal(series.items.reduce((acc, item) => acc + item.cacheRead, 0), days * 500);
});

test('空数据与零输入兜底：仍输出完整卡片，缓存命中显示 --', () => {
  const svg = buildShareCardSvg({ daily: {}, startKey: '2026-08-20', endKey: '2026-08-22' });
  assert.match(svg, /<svg/);
  assert.match(svg, />--</);
  assert.doesNotMatch(svg, /NaN|undefined/);
});

test('统计卡折线：靠右边缘的峰值也标注日期（夹紧到卡片内）', () => {
  // 10 天范围，峰值在第 9 天（右边缘附近）：旧规则会跳过，现在必须标注
  const daily = {};
  for (let i = 9; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(2026, 7, 22));
    d.setUTCDate(d.getUTCDate() - i);
    daily[d.toISOString().slice(0, 10)] = { input: 1000, output: 100, cacheRead: 0 };
  }
  daily['2026-08-21'] = { input: 9000, output: 900, cacheRead: 0 };
  const svg = buildShareCardSvg({ daily, startKey: '2026-08-13', endKey: '2026-08-22' });
  // 折线日期标签行 y=259（ROW_STAT_Y 100 + ROW_STAT_H 168 - 9），区别于柱图刻度
  assert.match(svg, /<text[^>]*y="259"[^>]*>08\.21</);
});

test('页脚：左品牌名，右 GitHub 项目链接', () => {
  const svg = buildShareCardSvg({ daily: FIXTURE, startKey: '2026-08-20', endKey: '2026-08-22' });
  assert.match(svg, /Kimi Code Monitor/);
  assert.match(svg, /github\.com\/bfjnbvf\/kimi-code-monitor/);
});

test('SVG 不含脚本与外部引用，可安全光栅化', () => {
  const svg = buildShareCardSvg({ daily: FIXTURE, startKey: '2026-08-20', endKey: '2026-08-22' });
  assert.doesNotMatch(svg, /<script|href=|xlink|@import|url\(http/i);
});
