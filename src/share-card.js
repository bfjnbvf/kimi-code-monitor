/**
 * 用量分享卡片（纯函数层）
 *
 * 职责边界：
 * - 输入按天用量桶与日期范围，输出一张独立 SVG 字符串。
 * - 不碰 DOM / chrome API / 网络；popup 负责取数、预览与 PNG 导出。
 * - 数据口径与 popup 按天统计一致：metrics.js 的 sumUsageBetween / listDayKeysBetween。
 *
 * 视觉遵循 Kimi Web Design System（docs 附件 v1.0）：
 * - 色板：bg #ffffff / surface #fafbfc / line #e7eaee / text #14171c / muted #6b7280 / accent #1783ff
 * - 字阶：标题 22/500、数值 30/500、正文 13/400、辅助 12-13；字重只取 400/500
 * - 间距 4px 网格（8/16/24/32），卡片圆角 8px、1px line 描边
 * - 折线图移植面板小组件画法：渐变面积 + 1.5px 圆头折线 + 末端圆点，
 *   四色与面板一致（输入灰 / 输出绿 / 缓存橙 / 总量蓝）
 */

import {
  buildHeatmapData,
  formatTokenCount,
  formatPercentage,
  listDayKeysBetween,
  sumUsageBetween,
  toNonNegativeInteger
} from './metrics.js';
import { t } from './i18n.js';

export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1350;

const BG = '#fafbfc';
const CARD_BG = '#ffffff';
const INK = '#14171c';
const MUTED = '#6b7280';
const LINE = '#e7eaee';
const ACCENT = '#1783ff';
const GREEN = '#16c456';
const ORANGE = '#ff9500';
const HEAT_EMPTY = '#eceff3';

const SANS = "'Inter Variable', Inter, 'Helvetica Neue', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif";
const MONO = "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, 'PingFang SC', monospace";

const PAD = 36;
const GAP = 16;
const CONTENT_W = CARD_WIDTH - PAD * 2;

// 纵向布局（y 区间）
const ROW_STAT_Y = 100;
const ROW_STAT_H = 168;
const ROW_BARS_Y = 284;
const ROW_BARS_H = 520;
const ROW_GRID_Y = 820;
const ROW_GRID_H = 400;

function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// '2026-08-01' → '2026.08.01'
function dotDate(key) {
  return String(key || '').replace(/-/g, '.');
}

function dayTotal(bucket) {
  return toNonNegativeInteger(bucket?.input) + toNonNegativeInteger(bucket?.output);
}

function daySub(bucket) {
  const sub = bucket?.sub;
  if (!sub) return 0;
  return Math.min(dayTotal(bucket), toNonNegativeInteger(sub.input) + toNonNegativeInteger(sub.output));
}

function emptyDayStat(key) {
  return { key, total: 0, sub: 0, input: 0, output: 0, cacheRead: 0, days: 0 };
}

function accumulate(target, bucket) {
  target.input += toNonNegativeInteger(bucket?.input);
  target.output += toNonNegativeInteger(bucket?.output);
  target.cacheRead += toNonNegativeInteger(bucket?.cacheRead);
  target.total = target.input + target.output;
  target.sub = Math.min(target.total, target.sub + daySub(bucket));
  target.days += 1;
}

// 范围 → 逐日绘图序列，无记录的天保留零值。
// 每个 item 携带 input/output/cacheRead 小计，供统计卡折线直接使用。
export function buildBarSeries(daily, startKey, endKey) {
  const keys = listDayKeysBetween(startKey, endKey);
  return {
    granularity: 'day',
    items: keys.map((key) => {
      const item = emptyDayStat(key);
      accumulate(item, daily?.[key]);
      return item;
    })
  };
}

function isMonday(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1)).getUTCDay() === 1;
}

/* ---------- 小组件：渐变折线（移植面板 sparkline 画法） ---------- */

let gradientSeq = 0;

// 贴边折线：横向铺满 [x, x+w]，末端圆点压在右边框线上。
// pairs 为 {v, key}，v 非有限值跳过；首/峰值/末三个关键点的日期标签
// 统一放在卡片内部下侧同一基线上（labelY 由调用方给定）。
function sparkline(x, y, w, h, pairs, color, clipId, labelY) {
  const pts = pairs.filter((p) => Number.isFinite(p.v));
  if (!pts.length) return '';
  const id = `sc-fade-${gradientSeq += 1}`;
  const clip = `sc-clip-${gradientSeq}`;
  const topPad = 8;
  const n = pts.length;
  const span = Math.max(1, pairs.length - 1);
  const max = Math.max(...pts.map((p) => p.v));
  const min = Math.min(0, ...pts.map((p) => p.v));
  const range = max - min || 1;
  const coords = pts.map((p) => ({
    // x 按原始日历位置排布（缺失值的天不挤占后续位置）
    cx: pairs.length === 1 ? x + w / 2 : x + (p.i / span) * w,
    cy: y + h - ((p.v - min) / range) * (h - topPad),
    key: p.key,
    v: p.v
  }));
  const linePoints = coords.map((p) => `${p.cx.toFixed(1)},${p.cy.toFixed(1)}`).join(' ');
  const last = coords[n - 1];
  const areaPoints = `${x},${y + h} ${linePoints} ${x + w},${y + h}`;
  let out =
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="${color}" stop-opacity="0.28"/>` +
    `<stop offset="1" stop-color="${color}" stop-opacity="0"/>` +
    `</linearGradient>` +
    `<clipPath id="${clip}"><rect x="${clipId.x}" y="${clipId.y}" width="${clipId.w}" height="${clipId.h}" rx="8"/></clipPath></defs>` +
    `<g clip-path="url(#${clip})">` +
    `<polygon points="${areaPoints}" fill="url(#${id})"/>` +
    `<polyline points="${linePoints}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` +
    `</g>` +
    // 末端圆点压在卡片右边框线上（不参与裁剪）
    `<circle cx="${(x + w).toFixed(1)}" cy="${last.cy.toFixed(1)}" r="3.5" fill="${color}"/>`;

  // 日期标签统一底部一行。候选：首点、最高峰、次高峰、末点；按优先级放入，
  // 水平间距不足 48px 的让位（首末日期页眉已有，波峰更值钱）。
  // 次高峰需与最高峰拉开 1/6 宽度，否则只是同一波峰的两肩。
  const label = (p, anchor, lx) =>
    `<text x="${lx.toFixed(1)}" y="${labelY}" text-anchor="${anchor}" font-family="${MONO}" font-size="11" fill="${MUTED}">${esc(p.key.slice(5).replace('-', '.'))}</text>`;
  const first = coords[0];
  let peak1 = null;
  let peak2 = null;
  for (const p of coords) {
    if (!peak1 || p.v > peak1.v) {
      peak2 = peak1;
      peak1 = p;
    } else if (!peak2 || p.v > peak2.v) {
      peak2 = p;
    }
  }
  const clamp = (cx) => Math.min(x + w - 30, Math.max(x + 30, cx));
  const candidates = [];
  if (peak1 && peak1 !== first && peak1 !== last) candidates.push({ p: peak1, lx: clamp(peak1.cx), anchor: 'middle', prio: 0 });
  if (
    peak2 && peak2 !== first && peak2 !== last &&
    Math.abs(peak2.cx - peak1.cx) >= w / 6
  ) candidates.push({ p: peak2, lx: clamp(peak2.cx), anchor: 'middle', prio: 1 });
  candidates.push({ p: first, lx: x + 10, anchor: 'start', prio: 2 });
  if (last !== first) candidates.push({ p: last, lx: x + w - 10, anchor: 'end', prio: 3 });
  const placed = [];
  for (const c of candidates.sort((a, b) => a.prio - b.prio)) {
    // 按锚点折算文字实际中心再判距（start 在 lx 右侧、end 在 lx 左侧约 17px）
    const center = (q) => (q.anchor === 'middle' ? q.lx : q.anchor === 'start' ? q.lx + 17 : q.lx - 17);
    if (placed.every((q) => Math.abs(center(q) - center(c)) > 52)) {
      out += label(c.p, c.anchor, c.lx);
      placed.push(c);
    }
  }
  return out;
}

/* ---------- 小组件：卡片容器与文字 ---------- */

function cardRect(x, y, w, h) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${CARD_BG}" stroke="${LINE}" stroke-width="1"/>`;
}

function cardLabel(x, y, text) {
  return `<text x="${x}" y="${y}" font-family="${SANS}" font-size="13" fill="${MUTED}">${esc(text)}</text>`;
}

// 范围汇总用的两位小数计数（比 formatTokenCount 多一档精度）
function formatPrecise(value) {
  const number = toNonNegativeInteger(value);
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(2)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(2)}k`;
  return String(number);
}

// 顶部统计卡：标签左对齐、等宽数值右对齐（同一行），下方贴边渐变折线 + 底部日期行
function statCard(x, w, label, value, items, pick, color) {
  const y = ROW_STAT_Y;
  const pairs = items.map((item, i) => ({ v: pick(item), key: item.key, i }));
  return (
    cardRect(x, y, w, ROW_STAT_H) +
    `<text x="${x + 16}" y="${y + 42}" font-family="${SANS}" font-size="13" fill="${MUTED}">${esc(label)}</text>` +
    `<text x="${x + w - 16}" y="${y + 42}" text-anchor="end" font-family="${MONO}" font-size="30" font-weight="500" fill="${INK}">${esc(value)}</text>` +
    sparkline(x, y + 56, w, ROW_STAT_H - 56 - 26, pairs, color, { x, y, w, h: ROW_STAT_H }, y + ROW_STAT_H - 9)
  );
}

/* ---------- 主图：每日消耗堆叠柱 ---------- */

function barsCard(items, sum) {
  const x = PAD;
  const y = ROW_BARS_Y;
  const w = CONTENT_W;
  const h = ROW_BARS_H;
  let out =
    cardRect(x, y, w, h) +
    cardLabel(x + 24, y + 44, t('每日消耗')) +
    // 右上角：总量与统计卡数值同款字体字级，缓存命中相对小一号沉在下方
    `<text x="${x + w - 24}" y="${y + 48}" text-anchor="end" font-family="${MONO}" font-size="30" font-weight="500" fill="${INK}">${esc(formatTokenCount(sum.totalTokens))}</text>` +
    (sum.cacheHitRate != null
      ? `<text x="${x + w - 24}" y="${y + 72}" text-anchor="end" font-family="${MONO}" font-size="13" fill="${MUTED}">${t('缓存命中 {pct}%', { pct: formatPercentage(sum.cacheHitRate * 100) })}</text>`
      : '');

  const n = items.length;
  const chartX = x + 24;
  const chartW = w - 48;
  const baseline = y + h - 72;
  const maxH = baseline - (y + 108);
  if (n) {
    const maxTotal = Math.max(1, ...items.map((item) => item.total));
    // 纵轴参照：固定间距的浅灰横线（25/50/75/100%），数值标在线的最左端
    const gutter = 52;
    const plotX = chartX + gutter;
    const plotW = chartW - gutter;
    for (const fraction of [0.25, 0.5, 0.75, 1]) {
      const gy = (baseline - fraction * maxH).toFixed(1);
      out += `<line x1="${plotX}" y1="${gy}" x2="${plotX + plotW}" y2="${gy}" stroke="${LINE}" stroke-width="1"/>`;
      out += `<text x="${plotX - 10}" y="${(Number(gy) + 4).toFixed(1)}" text-anchor="end" font-family="${MONO}" font-size="11" fill="${MUTED}">${esc(formatTokenCount(maxTotal * fraction))}</text>`;
    }
    // 固定柱间距（天数多时间距收窄），柱宽按数量动态分配（超上限时整排居中）
    const BAR_GAP = n > 60 ? 4 : n > 30 ? 8 : 12;
    const barWidth = Math.min(64, (plotW - (n - 1) * BAR_GAP) / n);
    const rowW = n * barWidth + (n - 1) * BAR_GAP;
    const startX = plotX + (plotW - rowW) / 2;
    const barCenter = (i) => startX + i * (barWidth + BAR_GAP) + barWidth / 2;
    let peakIndex = 0;
    items.forEach((item, i) => {
      if (item.total > items[peakIndex].total) peakIndex = i;
      if (item.total <= 0) return;
      const cx = barCenter(i);
      const bx = (cx - barWidth / 2).toFixed(1);
      const hTotal = Math.max(4, (item.total / maxTotal) * maxH);
      const hSub = Math.min(hTotal, (item.sub / maxTotal) * maxH);
      const yTop = baseline - hTotal;
      // 与面板/popup 柱图同口径：主代理蓝底、子代理绿顶堆叠
      out += `<rect x="${bx}" y="${yTop.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${hSub.toFixed(1)}" fill="${GREEN}"/>`;
      out += `<rect x="${bx}" y="${(yTop + hSub).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${(hTotal - hSub).toFixed(1)}" fill="${ACCENT}"/>`;
    });
    // 峰值图注：最高柱上方 12px 灰字
    const peakItem = items[peakIndex];
    if (peakItem && peakItem.total > 0) {
      const cx = Math.min(
        plotX + plotW - 70,
        Math.max(plotX + 70, barCenter(peakIndex))
      );
      const hTotal = Math.max(4, (peakItem.total / maxTotal) * maxH);
      out += `<text x="${cx.toFixed(1)}" y="${(baseline - hTotal - 12).toFixed(1)}" text-anchor="middle" font-family="${SANS}" font-size="12" fill="${MUTED}">${t('峰值 {date} · {value}', { date: peakItem.key.slice(5).replace('-', '.'), value: formatTokenCount(peakItem.total) })}</text>`;
    }
    // 刻度：首尾必标，中间标周一，总数控制在 8 个以内
    const picked = new Set([0, n - 1]);
    const step = Math.max(1, Math.ceil(n / 7));
    for (let i = 0; i < n; i += 1) {
      if (isMonday(items[i].key)) {
        picked.add(Math.min(n - 1, Math.round(i / step) * step));
      }
    }
    for (const i of [...picked].sort((a, b) => a - b)) {
      const cx = barCenter(i);
      out += `<text x="${cx.toFixed(1)}" y="${baseline + 26}" text-anchor="middle" font-family="${MONO}" font-size="12" fill="${MUTED}">${esc(items[i].key.slice(5).replace('-', '.'))}</text>`;
    }
  }
  out += `<line x1="${chartX + 52}" y1="${baseline}" x2="${chartX + chartW}" y2="${baseline}" stroke="${LINE}" stroke-width="1"/>`;
  return out;
}

/* ---------- 左下：活跃热力图（跟随所选日期范围） ---------- */

function heatmapCard(x, y, w, h, daily, startKey, endKey) {
  const dayCount = listDayKeysBetween(startKey, endKey).length;
  const { weeks } = buildHeatmapData(daily, endKey, dayCount);
  const cols = weeks.length;
  const gap = 3;
  // 格子取宽/高两个方向的较小者，整体在卡片内水平垂直居中
  const availW = w - 48;
  const availH = h - 64 - 32;
  const cell = Math.min((availW - (cols - 1) * gap) / cols, (availH - 6 * gap) / 7);
  const gridW = cols * cell + (cols - 1) * gap;
  const gridH = 7 * cell + 6 * gap;
  const gridX = x + 24 + (availW - gridW) / 2;
  const gridY = y + 64 + (availH - gridH) / 2;
  let grid = '';
  for (const [weekIndex, week] of weeks.entries()) {
    // 首列顶到首日的星期序（周一起），与 popup 热力图一致
    const padTop = weekIndex === 0 ? 7 - week.length : 0;
    for (const [rowIndex, heatCell] of week.entries()) {
      const cx = gridX + weekIndex * (cell + gap);
      const cy = gridY + (padTop + rowIndex) * (cell + gap);
      const fill = heatCell.level === 0 ? HEAT_EMPTY : ACCENT;
      const opacity = heatCell.level === 0 ? 1 : [0, 0.25, 0.45, 0.65, 1][heatCell.level];
      grid += `<rect x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" width="${cell.toFixed(1)}" height="${cell.toFixed(1)}" rx="2" fill="${fill}"${opacity === 1 ? '' : ` fill-opacity="${opacity}"`}/>`;
    }
  }
  // 活跃天数在右侧「范围汇总」里，卡片头部不再重复计数
  return cardRect(x, y, w, h) + cardLabel(x + 24, y + 40, t('活跃热力图 · {n} 天', { n: dayCount })) + grid;
}

/* ---------- 右下：范围汇总 ---------- */

function summaryRow(x, y, w, label, value, withRule) {
  return (
    `<text x="${x}" y="${y}" font-family="${SANS}" font-size="13" fill="${MUTED}">${esc(label)}</text>` +
    `<text x="${x + w}" y="${y}" text-anchor="end" font-family="${MONO}" font-size="24" font-weight="500" fill="${INK}">${esc(value)}</text>` +
    (withRule ? `<line x1="${x}" y1="${y + 14}" x2="${x + w}" y2="${y + 14}" stroke="${LINE}" stroke-width="1"/>` : '')
  );
}

function summaryCard(x, y, w, h, rows) {
  let out = cardRect(x, y, w, h) + cardLabel(x + 24, y + 40, t('范围汇总'));
  // 数据行整体下对齐：与标题之间留出呼吸间距，行块贴卡片底部（留 24px 内边距）
  const rowH = 48;
  const blockTop = y + h - 24 - rows.length * rowH;
  rows.forEach((row, i) => {
    out += summaryRow(x + 24, blockTop + i * rowH + 22, w - 48, row[0], row[1], i < rows.length - 1);
  });
  return out;
}

/**
 * 生成分享卡片 SVG。
 * @param {object} options
 * @param {object} options.daily 按天用量桶（kimiCliUsageDaily）
 * @param {string} options.startKey 起始日 'YYYY-MM-DD'
 * @param {string} options.endKey 结束日 'YYYY-MM-DD'
 * @returns {string} 独立 SVG 字符串
 */
export function buildShareCardSvg({ daily, startKey, endKey } = {}) {
  const source = daily && typeof daily === 'object' ? daily : {};
  const sum = sumUsageBetween(source, startKey, endKey);
  const { items } = buildBarSeries(source, startKey, endKey);
  const dayKeys = listDayKeysBetween(startKey, endKey);
  const totalSub = items.reduce((acc, item) => acc + item.sub, 0);
  const peakItem = items.reduce((best, item) => (item.total > (best?.total || 0) ? item : best), null);
  const activeInRange = dayKeys.filter((key) => dayTotal(source[key]) > 0).length;

  const statW = (CONTENT_W - GAP * 3) / 4;
  const avgPerActiveDay = activeInRange > 0 ? Math.round(sum.totalTokens / activeInRange) : 0;

  const heatW = 600;
  const heatSvg = heatmapCard(PAD, ROW_GRID_Y, heatW, ROW_GRID_H, source, startKey, endKey);
  const summaryX = PAD + heatW + GAP;
  const summaryW = CONTENT_W - heatW - GAP;
  const summaryRows = [
    [t('活跃天数'), t('{a} / {b} 天', { a: activeInRange, b: dayKeys.length })],
    [t('日均消耗'), activeInRange > 0 ? t('{v} / 天', { v: formatPrecise(avgPerActiveDay) }) : '--'],
    [t('主代理'), formatPrecise(Math.max(0, sum.totalTokens - totalSub))],
    [t('子代理'), totalSub > 0 ? formatPrecise(totalSub) : '--'],
    [t('峰值日'), peakItem ? `${peakItem.key.slice(5).replace('-', '.')} · ${formatPrecise(peakItem.total)}` : '--']
  ];

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">
  <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${BG}"/>

  <!-- 页眉：标题 + 日期范围（22/500 页面标题字阶） -->
  <rect x="${PAD}" y="46" width="12" height="12" rx="3" fill="${ACCENT}"/>
  <text x="${PAD + 24}" y="57" font-family="${SANS}" font-size="22" font-weight="500" fill="${INK}">${t('Kimi Code 用量')}</text>
  <text x="${CARD_WIDTH - PAD}" y="57" text-anchor="end" font-family="${MONO}" font-size="13" fill="${MUTED}">${esc(dotDate(startKey))} – ${esc(dotDate(endKey))}</text>

  <!-- 四张统计卡：输入灰 / 输出绿 / 缓存橙 / 总消耗蓝，各带贴边渐变折线 -->
  ${statCard(PAD, statW, t('输入'), formatTokenCount(sum.input), items, (item) => item.input, MUTED)}
  ${statCard(PAD + (statW + GAP), statW, t('输出'), formatTokenCount(sum.output), items, (item) => item.output, GREEN)}
  ${statCard(PAD + (statW + GAP) * 2, statW, t('缓存命中'), sum.cacheHitRate != null ? `${formatPercentage(sum.cacheHitRate * 100)}%` : '--', items, (item) => (item.input > 0 ? (item.cacheRead / item.input) * 100 : null), ORANGE)}
  ${statCard(PAD + (statW + GAP) * 3, statW, t('总消耗'), formatTokenCount(sum.totalTokens), items, (item) => item.total, ACCENT)}

  <!-- 每日消耗堆叠柱（主蓝子绿） -->
  ${barsCard(items, sum)}

  <!-- 热力图 + 范围汇总 -->
  ${heatSvg}
  ${summaryCard(summaryX, ROW_GRID_Y, summaryW, ROW_GRID_H, summaryRows)}

  <text x="${PAD}" y="${CARD_HEIGHT - 32}" font-family="${SANS}" font-size="12" fill="${MUTED}">Kimi Code Monitor</text>
  <text x="${CARD_WIDTH - PAD}" y="${CARD_HEIGHT - 32}" text-anchor="end" font-family="${MONO}" font-size="12" fill="${MUTED}">github.com/bfjnbvf/kimi-code-monitor</text>
</svg>`;
}
