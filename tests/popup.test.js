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
const tidySource = fs.readFileSync(path.join(__dirname, '..', 'src', 'popup', 'tidy.js'), 'utf8');
const petsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'popup', 'pets.js'), 'utf8');
const shareCardSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'popup', 'share-card.js'), 'utf8');
// 全板块拼接：供「任何地方都不许出现」类断言使用
const allPopupSource = [usageSource, accountsSource, externalSource, renameSource, tidySource, petsSource, shareCardSource].join('\n');
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

test('扩展功能卡片：收藏、自动归档与自动命名（复制提示词引导）三个子块', () => {
  assert.match(html, /id="extensions-section"/);
  assert.match(html, /扩展功能/);
  // 自动命名子块：复制提示词引导（无扩展端开关/管线），教程即提示词本身
  assert.match(html, /id="ext-rename-block"/);
  assert.match(html, /id="rename-copy-prompt"/);
  assert.doesNotMatch(html, /rename-auto-toggle|rename-model-select|rename-emoji-on|rename-usage/);
  assert.match(html, /官方实验「AI session titles」/);
  assert.match(html, /完成后运行 \/reload 生效/);
  assert.match(css, /\.kswitch::after/);
  // 子块一：收藏开关（默认开，关闭时内容侧停星标与收藏页）
  assert.match(html, /id="ext-bookmarks-block"/);
  assert.match(html, /id="bookmarks-toggle"/);
  // 子块三：自动归档——首跑一次性流程（dry run 条数 + 清理并解锁），
  // 无模式下拉、无常驻待确认入口；三档阈值常驻
  assert.match(html, /id="ext-tidy-block"/);
  assert.match(html, /id="tidy-toggle"/);
  assert.doesNotMatch(html, /tidy-mode-select|tidy-mode-auto|tidy-candidates-btn/);
  assert.match(html, /id="tidy-candidates"/);
  assert.match(html, /id="tidy-t1"/);
  assert.match(html, /id="tidy-t2"/);
  assert.match(html, /id="tidy-t3"/);
  // 功能介绍不占行：统一放在卡片 ⓘ hover 弹层（悬浮即读，与开关状态无关）
  assert.match(html, /AI 回复收藏：点击 AI 回复下方的星标即可收藏/);
  assert.match(html, /自动归档不活跃对话：按静默天数/);
  assert.match(html, /完成后运行 \/reload 生效/);
  assert.match(css, /\.ext-block-sub \{[^}]*font-size: 11px/);
  // 子块标题与「账户 1」(.ext-name) 同规范：11px、不加粗
  assert.match(css, /\.ext-block-head \.usage-title \{[^}]*font-size: 11px/);
  assert.match(css, /\.ext-block-head \.usage-title \{[^}]*font-weight: 400/);
  // ⓘ 弹层 hover 时提升自身层级，不被后面的开关按钮盖住
  assert.match(css, /\.info-icon:hover \{[^}]*z-index/);
  // 首跑的「清理并解锁自动归档」/「点击解锁自动归档」都用主题蓝，表明可点击
  assert.match(css, /button\.action\.tidy-unlock-btn \{ color: var\(--accent\)/);
  // 批量功能已移除：无天数选择/开始按钮/状态行/诊断日志链接
  assert.doesNotMatch(html, /rename-days|rename-start-btn|rename-status|rename-debug-link/);
  assert.doesNotMatch(allPopupSource, /rename\.batch\./);
  assert.doesNotMatch(allPopupSource, /collectCustomTitleSessionIds/);
  assert.doesNotMatch(backgroundSource, /rename\.batch\./);
  // 复制提示词模块：提示词全文与剪贴板降级都在 rename.js，扩展端无生成管线
  assert.match(renameSource, /auto_session_title = true/);
  assert.match(renameSource, /KIMI_CODE_HOME/);
  assert.match(renameSource, /navigator\.clipboard\.writeText/);
  assert.doesNotMatch(allPopupSource, /sessionRenameSettings/);
  // tidy 设置与候选/整理走 background 中继；解锁门控在 popup 侧
  assert.match(tidySource, /'kimiTidySettings'/);
  assert.match(tidySource, /kimiTidyManualDoneAt/);
  assert.match(tidySource, /send\('tidy\.candidates'\)/);
  assert.match(tidySource, /send\('tidy\.apply', \{ ids: candidates\.map\(\(c\) => c\.id\) \}\)/);
  assert.match(tidySource, /send\('tidy\.lab\.ensure'\)/);
  assert.match(tidySource, /'kimiFeatureBookmarks'/);
  // 首跑即 dry run：显示待归档条数与「清理并解锁自动归档」；空结果给
  // 「点击解锁自动归档」。解锁同时写 lastRun，首次自动归档从 24 小时后
  // 开始（不立即清扫用户刻意留下的对话）
  assert.match(tidySource, /有 \{n\} 条对话待归档/);
  // 首跑面板列出具体会话名，最多 8 条其余折入省略行
  assert.match(tidySource, /……以及其他 \{m\} 个对话/);
  assert.match(tidySource, /tidy-first-item/);
  assert.match(tidySource, /读取失败：\{msg\}/);
  assert.match(tidySource, /清理并解锁自动归档/);
  assert.match(tidySource, /点击解锁自动归档/);
  assert.match(tidySource, /TIDY_MANUAL_DONE_STORAGE_KEY\]: Date\.now/);
  assert.match(tidySource, /TIDY_LAST_RUN_STORAGE_KEY\]: \{ at: Date\.now\(\)/);
  assert.match(tidySource, /renderTidyPhase/);
  assert.match(tidySource, /runFirstRunPanel/);
  assert.doesNotMatch(tidySource, /tidyModeSelect|tidy-candidates-btn/);
  assert.match(backgroundSource, /'tidy\.candidates':/);
  assert.match(backgroundSource, /'tidy\.apply':/);
  assert.match(backgroundSource, /'tidy\.settings\.updated':/);
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
