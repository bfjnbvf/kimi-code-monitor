import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'popup.css'), 'utf8');
const usageSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'popup', 'usage.js'), 'utf8');
const accountsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'popup', 'accounts.js'), 'utf8');
const externalSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'popup', 'external.js'), 'utf8');
const renameSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'popup', 'rename.js'), 'utf8');
const petsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'popup', 'pets.js'), 'utf8');
const shareCardSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'popup', 'share-card.js'), 'utf8');
// 全板块拼接：供「任何地方都不许出现」类断言使用
const allPopupSource = [usageSource, accountsSource, externalSource, renameSource, petsSource, shareCardSource].join('\n');
const backgroundSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'background.js'), 'utf8');

test('本地记录授权提供路径提示、选错目录报错及重新授权和取消入口', () => {
  assert.match(html, /id="cli-path-help"/);
  assert.match(html, /id="cli-error" role="alert"/);
  assert.match(html, /id="cli-reauth-btn">重新授权/);
  assert.match(html, /id="cli-disconnect-btn">取消/);
  assert.match(usageSource, /handle\.name !== '\.kimi-code'/);
  assert.match(usageSource, /目录选择错误/);
  assert.match(usageSource, /⌘⇧\./);
  assert.match(usageSource, /%USERPROFILE%/);
});

test('扫描中只轮询内存进度，并显示整数百分比', () => {
  // 改为串行 setTimeout：上一次响应回来才排下一次，避免请求堆积
  assert.match(usageSource, /function cliProgressPoll\(\)/);
  assert.match(usageSource, /setTimeout\(cliProgressPoll, CLI_PROGRESS_INTERVAL_MS\)/);
  assert.match(usageSource, /t\('正在读取本地记录 \{pct\}%', \{ pct: progress \}\)/);
});

test('额度授权状态并入 Kimi 账户区块，本地记录保持独立状态行', () => {
  assert.match(usageSource, /本地记录已授权/);
  // 独立「额度接口已授权」状态行已移除：零账户空态提供「去授权」，提示并入账户区块
  assert.match(html, /id="account-empty"/);
  assert.match(html, /id="account-auth-btn">去授权/);
  assert.doesNotMatch(html, /id="status-text"/);
  assert.doesNotMatch(html, /id="clear-btn"/);
  assert.doesNotMatch(usageSource, /formatExpiry|有效期至/);
});

test('popup 只提供可按日期聚合的指标选择', () => {
  assert.match(html, /id="usage-metric"/);
  for (const value of ['total', 'input', 'output', 'cache']) {
    assert.match(html, new RegExp(`<option value="${value}">`));
  }
  assert.doesNotMatch(html, /<option value="speed">/);
  assert.match(usageSource, /const USAGE_METRICS = \{/);
  assert.match(usageSource, /USAGE_METRIC_STORAGE_KEY/);
});

test('默认日期范围：结束日期为当天，起始日期为一个月前（早于最早记录则取最早记录）', () => {
  assert.match(usageSource, /monthAgo\.setUTCMonth\(monthAgo\.getUTCMonth\(\) - 1\)/);
  assert.match(usageSource, /usageStartEl\.value = monthAgoKey < firstKey \? firstKey : monthAgoKey/);
  assert.match(usageSource, /if \(!usageEndEl\.value\) usageEndEl\.value = todayKey/);
});

test('消耗量指标下主/子代理堆叠渲染（蓝底绿顶）', () => {
  assert.match(css, /\.usage-bar\.sub \{/);
  assert.match(usageSource, /usageMetric === 'total' && subTokens > 0 && maxValue > 0/);
  assert.match(usageSource, /subBar\.className = 'usage-bar sub'/);
  assert.match(usageSource, /stacked \? 'usage-bar flat' : 'usage-bar'/);
});

test('导出统计包含 CLI 按日汇总与额度快照，不含对话原文', () => {
  assert.match(html, /id="export-link">导出统计/);
  assert.match(usageSource, /KimiCliUsage\.DAILY_STORAGE_KEY/);
  assert.match(usageSource, /quotaSnapshots/);
  assert.match(usageSource, /quotaMonthlyLast/);
  assert.match(usageSource, /导出不包含 CLI 对话原文/);
});

test('外部账户行：textContent 渲染无注入面，改名/移除统一及失败保留列表', () => {
  // 动态值用 textContent 渲染，不经过 innerHTML（仅静态路径帮助文案例外）
  assert.match(externalSource, /name\.textContent = account\.keyTail/);
  assert.doesNotMatch(allPopupSource, /innerHTML\s*=\s*`/);
  // t('中文常量') 形式放行：i18n 迁移后 innerHTML = t('…') 仍是静态文案
  assert.doesNotMatch(allPopupSource, /innerHTML\s*=\s*(?!t\()[^\s'"]/);
  // 操作与 Kimi 账户统一：改名 + 移除，无「删除」字样
  assert.match(externalSource, /renameBtn\.textContent = t\('改名'\)/);
  assert.match(externalSource, /removeBtn\.textContent = t\('移除'\)/);
  assert.match(externalSource, /send\('external\.rename', \{ id: account\.id, label \}\)/);
  assert.doesNotMatch(allPopupSource, /删除/);
  assert.match(backgroundSource, /'external\.rename': renameExternalAccount/);
  // 移除失败时保留列表与本地缓存，并在列表区域提示
  assert.match(externalSource, /if \(!response\?\.ok\) throw new Error\(response\?\.error \|\| t\('移除失败'\)\)/);
  assert.match(externalSource, /renderExternalAccounts\(t\('移除失败：\{msg\}', \{ msg: error\?\.message \|\| error \}\)\)/);
  assert.match(externalSource, /catch \(error\) \{[^}]*renderExternalAccounts/s);
});

test('活跃热力图作为默认指标：固定 140 天窗口，版式与其他指标一致', () => {
  // 默认选中活跃热力图（选项置首位并带 selected）
  assert.match(html, /<option value="heatmap" selected>活跃热力图<\/option>/);
  assert.match(usageSource, /let usageMetric = 'heatmap'/);
  // 热力图模式只隐藏单日标签与日期范围选择器；大数字保留（显示 140 天总消耗）
  assert.match(css, /\.usage-data\.heatmap-mode #usage-day[\s\S]*?\.usage-data\.heatmap-mode \.usage-dates[\s\S]*?display: none/);
  assert.doesNotMatch(css, /\.usage-data\.heatmap-mode \.usage-big-tokens/);
  // 图表区固定为与「柱状图 + 日期行」等高的 76px，切换指标时卡片版式不动
  assert.match(css, /\.usage-data\.heatmap-mode \.usage-chart \{[\s\S]*?height: 76px/);
  // 大数字显示 140 天窗口总消耗
  assert.match(usageSource, /usageTokensEl\.textContent = totalSum > 0 \? formatTokenCount\(totalSum\) : '--'/);
  // 固定最近 140 天窗口（约 20 周），不读日期范围选择器
  assert.match(usageSource, /buildHeatmapData\(usageDaily, usageDayKey\(new Date\(\)\), HEATMAP_DAYS\)/);
  assert.match(usageSource, /if \(usageMetric === 'heatmap'\) \{\s*usageDataEl\.classList\.add\('heatmap-mode'\);/);
  // heatmap 是合法的可持久化选项，但不是数值指标
  assert.match(usageSource, /id === 'heatmap' \|\| Boolean\(USAGE_METRICS\[id\]\)/);
  assert.doesNotMatch(usageSource, /heatmap: \{/);
});

test('Kimi 账户区块：列表与添加入口，操作走独立消息', () => {
  assert.match(html, /id="account-section"/);
  assert.match(html, /id="account-list"/);
  assert.match(html, /id="account-add-btn">\+ 添加账户/);
  assert.match(html, /id="account-label-input"/);
  assert.match(html, /id="account-add-save">去授权/);
  assert.match(css, /\.account-badge \{/);
  // 切换/移除/改名/添加/重新授权各自独立消息
  assert.match(accountsSource, /send\('accounts\.switch', \{ id: account\.id \}\)/);
  assert.match(accountsSource, /send\('accounts\.remove', \{ id: account\.id \}\)/);
  assert.match(accountsSource, /send\('accounts\.rename', \{ id: account\.id, label \}\)/);
  assert.match(accountsSource, /send\('oauth\.add', \{ label \}\)/);
  assert.match(accountsSource, /send\('oauth\.reauth', \{ id: account\.id \}\)/);
  // 失效账户标注「需重新授权」，激活账户显示「当前」标记
  assert.match(accountsSource, /需重新授权/);
  assert.match(accountsSource, /badge\.textContent = t\('当前'\)/);
});

test('新会话 AI 自动命名区块：模型下拉、开关与用量计数（仅自动命名，无批量入口）', () => {
  assert.match(html, /id="rename-section"/);
  assert.match(html, /新会话 AI 自动命名/);
  // 总开关在标题行右侧（iOS 风格胶囊开关，对齐 Kimi Web ui-switch 规格）
  assert.match(html, /<input type="checkbox" id="rename-auto-toggle" class="kswitch-input"><span class="kswitch">/);
  assert.match(css, /\.kswitch::after/);
  // 卡片说明不占行：标题右侧 ⓘ hover 气泡，含命名时机与 token 消耗说明
  assert.match(html, /class="info-icon"/);
  assert.match(html, /输入约 1500~2500 tokens/);
  assert.match(html, /第 3 轮对话结束后才命名/);
  assert.match(html, /手动改过的名字不会被覆盖/);
  assert.doesNotMatch(html, /ext-desc/);
  assert.match(html, /id="rename-model-select"/);
  // 标题带 emoji：打开/关闭文字按钮（与宠物卡片同款），当前态蓝色高亮
  assert.match(html, /<button type="button" class="action" id="rename-emoji-on">打开<\/button>/);
  assert.match(html, /<button type="button" class="action" id="rename-emoji-off">关闭<\/button>/);
  assert.doesNotMatch(html, /rename-emoji-toggle/);
  assert.match(html, /id="rename-auto-toggle"/);
  // 模型选择框带「使用模型」前缀标签
  assert.match(html, /<span class="ext-label">使用模型<\/span>/);
  // 批量功能已移除：无天数选择/开始按钮/状态行/诊断日志链接
  assert.doesNotMatch(html, /rename-days|rename-start-btn|rename-status|rename-debug-link/);
  assert.doesNotMatch(allPopupSource, /rename\.batch\./);
  assert.doesNotMatch(allPopupSource, /collectCustomTitleSessionIds/);
  assert.doesNotMatch(backgroundSource, /rename\.batch\./);
  // 注释行降级：10px 灰字的 rename-minor（用量计数等注释内容沉底）
  assert.match(html, /class="rename-minor"/);
  assert.match(css, /\.rename-minor \{[\s\S]*?font-size: 10px[\s\S]*?var\(--text-tertiary\)/);
  // 开关与模型选择持久化；modelSource 为 {kind, model|accountId+model} 新结构
  assert.match(renameSource, /'sessionRenameSettings'/);
  assert.match(renameSource, /normalizeModelSource/);
  assert.match(renameSource, /kind === 'external'\s*\?\s*`ext:\$\{source\.accountId\}:\$\{source\.model \|\| ''\}`/);
  // 分组下拉：Kimi Code 一组；外部账户每家一个 optgroup，组内为 provider 实时模型
  assert.match(renameSource, /optgroup/);
  assert.match(renameSource, /kimiGroup\.label = 'Kimi Code'/);
  // 模型清单：缓存渲染 + 经 background 中继后台刷新；外部模型由 background 直连 provider
  assert.match(renameSource, /'sessionRenameModels'/);
  assert.match(renameSource, /send\('rename\.models\.list'\)/);
  assert.match(backgroundSource, /'rename\.models\.list': listRenameModels/);
  assert.match(renameSource, /send\('rename\.external\.models\.list'\)/);
  assert.match(backgroundSource, /'rename\.external\.models\.list': listExternalRenameModels/);
  // token 用量计数：popup 读取 background 累计值展示
  assert.match(renameSource, /send\('rename\.usage\.get'\)/);
  assert.match(backgroundSource, /'rename\.usage\.get': getRenameUsage/);
});

test('用量分享卡片：入口在消耗量板块内，构图纯函数与导出分离', () => {
  // 入口按钮在 .usage-data 内（CLI 未连接时随板块锁定隐藏），沿用按天统计的日期范围
  // 入口在 footer（替换原「重置布局」），文案为「分享用量」
  assert.match(html, /id="share-card-btn">分享用量/);
  assert.doesNotMatch(html, /reset-layout-link/);
  assert.doesNotMatch(html, /usage-share-row/);
  assert.match(shareCardSource, /document\.getElementById\('usage-start'\)\.value/);
  assert.match(shareCardSource, /document\.getElementById\('usage-end'\)\.value/);
  // SVG 构图来自共享纯函数模块；导出为 PNG（canvas.toBlob）与剪贴板（ClipboardItem）
  assert.match(shareCardSource, /import \{ buildShareCardSvg, CARD_WIDTH, CARD_HEIGHT \} from '\.\.\/share-card\.js'/);
  assert.match(shareCardSource, /canvas\.toBlob/);
  assert.match(shareCardSource, /new ClipboardItem\(\{ 'image\/png': blob \}\)/);
  // 预览弹层与操作按钮
  assert.match(html, /id="share-card-overlay" class="hidden"/);
  assert.match(html, /id="share-card-download">下载 PNG/);
  assert.match(html, /id="share-card-copy">复制图片/);
  assert.match(css, /#share-card-overlay \{[\s\S]*?position: fixed/);
  // blob URL 延迟回收，避免个别内核同步回收过早
  assert.match(shareCardSource, /BLOB_URL_REVOKE_MS/);
});
