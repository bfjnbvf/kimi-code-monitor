#!/usr/bin/env node
/**
 * 生成多日的 usageDaily 测试数据，输出可直接粘贴到浏览器控制台执行的代码。
 *
 * 用法：
 *   node tests/seed-usage-data.js [天数]        # 默认 45 天
 *   node tests/seed-usage-data.js | pbcopy      # 直接复制到剪贴板
 *
 * 粘贴位置（二选一）：
 *   1. chrome://extensions → Kimi Code Monitor → Service Worker → Console
 *   2. 扩展 popup 上右键 → 检查 → Console
 * 粘贴回车后刷新 popup 即可看到图表和日历的数据。
 */
const days = Math.max(1, Number(process.argv[2]) || 45);

const pad = (n) => String(n).padStart(2, '0');
const usageDaily = {};

for (let i = days - 1; i >= 0; i--) {
  const d = new Date();
  d.setDate(d.getDate() - i);
  const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  // 留几天空白，模拟没有使用的日子
  if (i % 11 === 5) continue;

  // 确定性波动：工作日高、周末低，带锯齿变化，便于目测图表高低
  const dayOfWeek = d.getDay();
  const weekend = dayOfWeek === 0 || dayOfWeek === 6;
  const wave = 0.5 + 0.5 * Math.sin(i * 1.7);
  const input = Math.round((weekend ? 300_000 : 1_200_000) * (0.4 + wave));
  const cacheRead = Math.round(input * (0.55 + 0.3 * (((i * 37) % 10) / 10)));
  const output = Math.round(input * (0.08 + 0.07 * (((i * 13) % 10) / 10)));

  usageDaily[key] = {
    input,
    output,
    cacheRead,
    // 约三成消耗来自子代理，便于测试堆叠双色柱状图
    sub: {
      input: Math.round(input * 0.3),
      output: Math.round(output * 0.3),
      cacheRead: Math.round(cacheRead * 0.3)
    }
  };
}

console.log(`chrome.storage.local.set({ usageDaily: ${JSON.stringify(usageDaily, null, 2)} });`);
