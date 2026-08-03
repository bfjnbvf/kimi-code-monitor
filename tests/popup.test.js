const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');

test('本地记录授权提供路径提示、选错目录报错及重新授权和取消入口', () => {
  assert.match(html, /id="cli-path-help"/);
  assert.match(html, /id="cli-error" role="alert"/);
  assert.match(html, /id="cli-reauth-btn">重新授权/);
  assert.match(html, /id="cli-disconnect-btn">取消/);
  assert.match(source, /handle\.name !== '\.kimi-code'/);
  assert.match(source, /目录选择错误/);
  assert.match(source, /⌘⇧\./);
  assert.match(source, /%USERPROFILE%/);
});

test('扫描中只轮询内存进度，并显示整数百分比', () => {
  assert.match(source, /setInterval\(\(\) => refreshCliStatus\(\{ refreshData: false \}\), 500\)/);
  assert.match(source, /正在读取本地记录 \$\{progress\}%/);
});

test('额度和本地记录使用彼此明确的授权名称', () => {
  assert.match(source, /额度接口已授权/);
  assert.match(source, /本地记录已授权/);
  assert.match(source, /authorized \? '重新授权' : '去授权'/);
  assert.doesNotMatch(html, /status-detail/);
  assert.doesNotMatch(source, /formatExpiry|有效期至/);
});

test('popup 只提供可按日期聚合的指标选择', () => {
  assert.match(html, /id="usage-metric"/);
  for (const value of ['total', 'input', 'output', 'cache']) {
    assert.match(html, new RegExp(`<option value="${value}">`));
  }
  assert.doesNotMatch(html, /<option value="speed">/);
  assert.match(source, /const USAGE_METRICS = \{/);
  assert.match(source, /USAGE_METRIC_STORAGE_KEY/);
});

test('消耗量指标下主/子代理堆叠渲染（蓝底绿顶）', () => {
  assert.match(html, /\.usage-bar\.sub \{/);
  assert.match(source, /usageMetric === 'total' && subTokens > 0 && maxValue > 0/);
  assert.match(source, /subBar\.className = 'usage-bar sub'/);
  assert.match(source, /stacked \? 'usage-bar flat' : 'usage-bar'/);
});

test('导出统计包含 CLI 按日汇总与额度快照，不含对话原文', () => {
  assert.match(html, /id="export-link">导出统计/);
  assert.match(source, /KimiCliUsage\.DAILY_STORAGE_KEY/);
  assert.match(source, /quotaSnapshots/);
  assert.match(source, /导出不包含 CLI 对话原文/);
});
