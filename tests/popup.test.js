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

test('活跃热力图作为指标选项：固定 90 天窗口，隐藏大数字与日期选择器', () => {
  assert.match(html, /<option value="heatmap">活跃热力图<\/option>/);
  // 热力图模式隐藏大数字、单日标签与日期范围选择器
  assert.match(html, /\.usage-data\.heatmap-mode \.usage-big-tokens[\s\S]*?\.usage-data\.heatmap-mode \.usage-dates[\s\S]*?display: none/);
  // 固定最近 90 天窗口，不读日期范围选择器
  assert.match(source, /buildHeatmapData\(usageDaily, usageDayKey\(new Date\(\)\)\)/);
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

test('AI 会话标题区块：扁平模型下拉、开关、天数与批量进度', () => {
  assert.match(html, /id="rename-section"/);
  assert.match(html, /AI 会话标题/);
  // 卡片说明不占行：标题右侧 ⓘ hover 气泡，含 token 消耗说明；旧的说明行已移除
  assert.match(html, /class="info-icon"/);
  assert.match(html, /输入约 1500~2500 tokens/);
  assert.match(html, /手动改过的名字不会被覆盖/);
  assert.doesNotMatch(html, /ext-desc/);
  assert.match(html, /id="rename-model-select"/);
  assert.match(html, /id="rename-emoji-toggle"/);
  assert.match(html, /id="rename-auto-toggle"/);
  for (const value of ['1', '3', '7', '30']) {
    assert.match(html, new RegExp(`<option value="${value}"`));
  }
  assert.match(html, /id="rename-start-btn">开始命名/);
  assert.match(html, /id="rename-status"/);
  // 次要设置降级：checkbox 包在 10px 灰字的 rename-minor 行里
  assert.match(html, /<div class="rename-minor">/);
  assert.match(html, /\.rename-minor \{[\s\S]*?font-size: 10px[\s\S]*?var\(--text-tertiary\)/);
  // 批量走 background 中转到活动 Kimi Code Web 标签页，进度由 content 直接广播
  assert.match(source, /send\('rename\.batch\.start', \{/);
  assert.match(source, /'rename\.batch\.progress'/);
  assert.match(source, /'rename\.batch\.done'/);
  assert.match(backgroundSource, /'rename\.batch\.start': startRenameBatch/);
  // 开关与模型选择持久化；modelSource 为 {kind, model|accountId} 新结构
  assert.match(source, /'sessionRenameSettings'/);
  assert.match(source, /normalizeModelSource/);
  assert.match(source, /kind === 'external' \? `ext:\$\{source\.accountId\}` : `kimi-code:\$\{source\.model\}`/);
  // 扁平下拉：Kimi Code 模型在前（display_name + Kimi Code 标注），不按账户分组
  assert.match(source, /`\$\{entry\.display_name\}（Kimi Code）`/);
  assert.doesNotMatch(source, /optgroup/i);
  // 模型清单：缓存渲染 + 经 background 中继后台刷新
  assert.match(source, /'sessionRenameModels'/);
  assert.match(source, /send\('rename\.models\.list'\)/);
  assert.match(backgroundSource, /'rename\.models\.list': listRenameModels/);
  // 手动标题保护：已连接 CLI 时由 popup 读 state.json 的 isCustomTitle 随消息带过去
  assert.match(source, /collectCustomTitleSessionIds/);
  assert.match(source, /getFileHandle\('state\.json'\)/);
  assert.match(source, /state\?\.isCustomTitle === true/);
  assert.match(source, /customTitleIds/);
  // 结果汇报：成功/跳过/失败三段
  assert.match(source, /成功 \$\{result\.succeeded \|\| 0\} · 跳过 \$\{result\.skipped \|\| 0\} · 失败 \$\{result\.failed \|\| 0\}/);
});
