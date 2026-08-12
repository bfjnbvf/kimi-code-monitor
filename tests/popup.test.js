const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
const backgroundSource = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

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

test('额度授权状态并入 Kimi 账户区块，本地记录保持独立状态行', () => {
  assert.match(source, /本地记录已授权/);
  // 独立「额度接口已授权」状态行已移除：零账户空态提供「去授权」，提示并入账户区块
  assert.match(html, /id="account-empty"/);
  assert.match(html, /id="account-auth-btn">去授权/);
  assert.doesNotMatch(html, /id="status-text"/);
  assert.doesNotMatch(html, /id="clear-btn"/);
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
  assert.match(source, /quotaMonthlyLast/);
  assert.match(source, /导出不包含 CLI 对话原文/);
});

test('外部账户行：textContent 渲染无注入面，改名/移除统一及失败保留列表', () => {
  // 动态值用 textContent 渲染，不经过 innerHTML（仅静态路径帮助文案例外）
  assert.match(source, /name\.textContent = account\.keyTail/);
  assert.doesNotMatch(source, /innerHTML\s*=\s*`/);
  assert.doesNotMatch(source, /innerHTML\s*=\s*[^\s'"]/);
  // 操作与 Kimi 账户统一：改名 + 移除，无「删除」字样
  assert.match(source, /renameBtn\.textContent = '改名'/);
  assert.match(source, /removeBtn\.textContent = '移除'/);
  assert.match(source, /send\('external\.rename', \{ id: account\.id, label \}\)/);
  assert.doesNotMatch(source, /删除/);
  assert.match(backgroundSource, /'external\.rename': renameExternalAccount/);
  // 移除失败时保留列表与本地缓存，并在列表区域提示
  assert.match(source, /if \(!response\?\.ok\) throw new Error\(response\?\.error \|\| '移除失败'\)/);
  assert.match(source, /renderExternalAccounts\(`移除失败：\$\{error\?\.message \|\| error\}`\)/);
  assert.match(source, /catch \(error\) \{[^}]*renderExternalAccounts/s);
});

test('活跃热力图作为指标选项：固定 90 天窗口，版式与其他指标一致', () => {
  assert.match(html, /<option value="heatmap">活跃热力图<\/option>/);
  // 热力图模式只隐藏单日标签与日期范围选择器；大数字保留（显示 90 天总消耗）
  assert.match(html, /\.usage-data\.heatmap-mode #usage-day[\s\S]*?\.usage-data\.heatmap-mode \.usage-dates[\s\S]*?display: none/);
  assert.doesNotMatch(html, /\.usage-data\.heatmap-mode \.usage-big-tokens/);
  // 图表区固定为与「柱状图 + 日期行」等高的 76px，切换指标时卡片版式不动
  assert.match(html, /\.usage-data\.heatmap-mode \.usage-chart \{[\s\S]*?height: 76px/);
  // 大数字显示 90 天窗口总消耗
  assert.match(source, /usageTokensEl\.textContent = totalSum > 0 \? formatTokenCount\(totalSum\) : '--'/);
  // 固定最近 140 天窗口（约 20 周），不读日期范围选择器
  assert.match(source, /buildHeatmapData\(usageDaily, usageDayKey\(new Date\(\)\), HEATMAP_DAYS\)/);
  assert.match(source, /if \(usageMetric === 'heatmap'\) \{\s*usageDataEl\.classList\.add\('heatmap-mode'\);/);
  // heatmap 是合法的可持久化选项，但不是数值指标
  assert.match(source, /id === 'heatmap' \|\| Boolean\(USAGE_METRICS\[id\]\)/);
  assert.doesNotMatch(source, /heatmap: \{/);
});

test('Kimi 账户区块：列表与添加入口，操作走独立消息', () => {
  assert.match(html, /id="account-section"/);
  assert.match(html, /id="account-list"/);
  assert.match(html, /id="account-add-btn">\+ 添加账户/);
  assert.match(html, /id="account-label-input"/);
  assert.match(html, /id="account-add-save">去授权/);
  assert.match(html, /\.account-badge \{/);
  // 切换/移除/改名/添加/重新授权各自独立消息
  assert.match(source, /send\('accounts\.switch', \{ id: account\.id \}\)/);
  assert.match(source, /send\('accounts\.remove', \{ id: account\.id \}\)/);
  assert.match(source, /send\('accounts\.rename', \{ id: account\.id, label \}\)/);
  assert.match(source, /send\('oauth\.add', \{ label \}\)/);
  assert.match(source, /send\('oauth\.reauth', \{ id: account\.id \}\)/);
  // 失效账户标注「需重新授权」，激活账户显示「当前」标记
  assert.match(source, /需重新授权/);
  assert.match(source, /badge\.textContent = '当前'/);
});

test('新会话 AI 自动命名区块：模型下拉、开关与用量计数（仅自动命名，无批量入口）', () => {
  assert.match(html, /id="rename-section"/);
  assert.match(html, /新会话 AI 自动命名/);
  // 总开关在标题行右侧（iOS 风格胶囊开关，对齐 Kimi Web ui-switch 规格）
  assert.match(html, /<input type="checkbox" id="rename-auto-toggle" class="kswitch-input"><span class="kswitch">/);
  assert.match(html, /\.kswitch::after/);
  // 卡片说明不占行：标题右侧 ⓘ hover 气泡，含命名时机与 token 消耗说明
  assert.match(html, /class="info-icon"/);
  assert.match(html, /输入约 1500~2500 tokens/);
  assert.match(html, /第 3 轮对话结束后才命名/);
  assert.match(html, /手动改过的名字不会被覆盖/);
  assert.doesNotMatch(html, /ext-desc/);
  assert.match(html, /id="rename-model-select"/);
  assert.match(html, /id="rename-emoji-toggle"/);
  assert.match(html, /id="rename-auto-toggle"/);
  // 模型选择框带「使用模型」前缀标签
  assert.match(html, /<span class="ext-label">使用模型<\/span>/);
  // 批量功能已移除：无天数选择/开始按钮/状态行/诊断日志链接
  assert.doesNotMatch(html, /rename-days|rename-start-btn|rename-status|rename-debug-link/);
  assert.doesNotMatch(source, /rename\.batch\./);
  assert.doesNotMatch(source, /collectCustomTitleSessionIds/);
  assert.doesNotMatch(backgroundSource, /rename\.batch\./);
  // 注释行降级：10px 灰字的 rename-minor（用量计数等注释内容沉底）
  assert.match(html, /class="rename-minor"/);
  assert.match(html, /\.rename-minor \{[\s\S]*?font-size: 10px[\s\S]*?var\(--text-tertiary\)/);
  // 开关与模型选择持久化；modelSource 为 {kind, model|accountId+model} 新结构
  assert.match(source, /'sessionRenameSettings'/);
  assert.match(source, /normalizeModelSource/);
  assert.match(source, /kind === 'external'\s*\?\s*`ext:\$\{source\.accountId\}:\$\{source\.model \|\| ''\}`/);
  // 分组下拉：Kimi Code 一组；外部账户每家一个 optgroup，组内为 provider 实时模型
  assert.match(source, /optgroup/);
  assert.match(source, /kimiGroup\.label = 'Kimi Code'/);
  // 模型清单：缓存渲染 + 经 background 中继后台刷新；外部模型由 background 直连 provider
  assert.match(source, /'sessionRenameModels'/);
  assert.match(source, /send\('rename\.models\.list'\)/);
  assert.match(backgroundSource, /'rename\.models\.list': listRenameModels/);
  assert.match(source, /send\('rename\.external\.models\.list'\)/);
  assert.match(backgroundSource, /'rename\.external\.models\.list': listExternalRenameModels/);
  // token 用量计数：popup 读取 background 累计值展示
  assert.match(source, /send\('rename\.usage\.get'\)/);
  assert.match(backgroundSource, /'rename\.usage\.get': getRenameUsage/);
});
