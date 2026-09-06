/**
 * i18n（gettext 风格）
 *
 * - 键 = 中文原文，迁移时只需把中文字符串包进 t()，已有中文断言的测试不破坏。
 * - 语言跟随 Kimi Web 的设置：页面 localStorage 的 `kimi-locale`（'zh' | 'en'），
 *   缺省回退浏览器语言。content.js 的 1s 路由轮询里调用 syncLocaleFromPage()
 *   检测变化并触发热切换。
 * - popup 是扩展自有页面，读不到页面 localStorage；content 每次同步时把当前语言
 *   镜像到 chrome.storage.local 的 MIRROR_STORAGE_KEY，popup 从那里读。
 */

import { STATUS_TEXT } from './content/utils.js';

const PAGE_LOCALE_KEY = 'kimi-locale';
export const LOCALE_MIRROR_STORAGE_KEY = 'kimi-statusbar.locale';

let currentLocale = 'zh';

// 英文翻译表：键为中文原文（含 {var} 占位符）
const EN = {
  // 状态
  '空闲': 'Idle',
  '思考中': 'Thinking',
  '调用中': 'Executing',
  '回复中': 'Replying',
  '未连接': 'Offline',
  '未授权': 'Unauthorized',
  '限流中': 'Rate limited',
  '子代理': 'Subagent',
  // 模块名
  '标题行': 'Header',
  '输入': 'Input',
  '缓存命中': 'Cache hit',
  '输出': 'Output',
  '速度': 'Speed',
  '上轮耗时': 'Last turn',
  '5h 额度': '5h quota',
  '本周额度': 'Weekly quota',
  '消耗量': 'Usage',
  '宠物': 'Pet',
  '外部账户': 'External accounts',
  // 模块内容
  '上轮': 'Last',
  '本周': 'Week',
  '本月': 'Month',
  '余额 --': 'Balance --',
  '余额': 'Balance',
  '代理': 'Agents',
  '命中': 'Hit',
  '主': 'main',
  '子': 'sub',
  '主代理': 'Main agent',
  '24h消耗': '24h usage',
  '今日消耗': "Today's usage",
  '7d消耗': '7d usage',
  '30d消耗': '30d usage',
  '本周消耗': 'This week',
  '需连接': 'Connect',
  '需连接 CLI': 'CLI required',
  '连接本地 CLI': 'Connect local CLI',
  '开启24h、7d、30d统计': 'Enable 24h/7d/30d stats',
  '即将重置': 'Resetting soon',
  '{days}天{hours}小时后重置': 'Resets in {days}d {hours}h',
  '{hours}小时{minutes}分钟后重置': 'Resets in {hours}h {minutes}m',
  '{totalMin}分钟后重置': 'Resets in {totalMin}m',
  '第{n}步 · 本轮结束': 'Step {n} · turn ended',
  '第{n}步': 'Step {n}',
  '子代理 {index}': 'Subagent {index}',
  '授权启动失败：{msg}': 'Authorization failed to start: {msg}',
  '额度更新失败：{msg}': 'Quota update failed: {msg}',
  '缓存命中 {pct}': 'Cache hit {pct}',
  '周日': 'Sun',
  '周一': 'Mon',
  '周二': 'Tue',
  '周三': 'Wed',
  '周四': 'Thu',
  '周五': 'Fri',
  '周六': 'Sat',
  '获取失败': 'Failed',
  '已启用': 'Enabled',
  '在扩展弹窗中配置 API Key': 'Configure API Key in the extension popup',
  'API余额': 'API balance',
  '暂无已配置账户': 'No accounts configured',
  // 面板交互
  '点击重置并重新拉取数据': 'Click to reset and refetch',
  '打开 Kimi Code 控制台': 'Open Kimi Code console',
  '查看 / 充值额度': 'View / top up quota',
  '模块设置': 'Module settings',
  '隐藏区 · 拖到下方启用': 'Hidden · drag below to enable',
  '展开区 · 展开时显示': 'Expanded · shown when expanded',
  '固定区 · 始终显示': 'Pinned · always visible',
  '隐藏区（顶部）': 'Hidden (top)',
  '展开区（中间）· 展开时显示': 'Expanded (middle) · shown when expanded',
  '固定区（底部）· Mini 也保留': 'Pinned (bottom) · kept in Mini mode',
  'Mini 模式：点击下方区域展开': 'Mini mode: click the bottom area to expand',
  'Kimi Status 已连接': 'Kimi Status connected',
  '编辑模式：拖拽模块排序，点 ≡ 配置，Esc 或点空白处完成': 'Edit mode: drag to reorder, ≡ to configure, Esc or click blank to finish',
  '显示': 'Show',
  '隐藏': 'Hide',
  '充值页': 'Top-up page',
  '控制台': 'Console',
  '半宽': 'Half',
  '整宽': 'Full',
  '显示代理': 'Show agents',
  '显示账户': 'Show accounts',
  '统计范围': 'Range',
  '匀速参照线': 'Pace reference',
  '重置时间显示': 'Reset time format',
  '倒计时': 'Countdown',
  '具体时间': 'Absolute time',
  '右侧数据': 'Right-side stat',
  '点击小球跳转': 'Ball click link',
  '无跳转': 'None',
  '侧栏改造（去 logo 上移）': 'Sidebar tidy (hide logo)',
  '开启': 'On',
  '关闭': 'Off',
  // 授权与连接提示
  '点击完成 Kimi 授权': 'Click to authorize Kimi',
  '点击授权 Kimi 额度查询': 'Click to authorize quota query',
  '正在打开 Kimi 授权页…': 'Opening Kimi authorization…',
  '无法开始授权': 'Cannot start authorization',
  '授权中，完成后自动恢复': 'Authorizing, resumes automatically',
  '请在新打开的页面完成授权': 'Complete authorization in the new page',
  '授权启动失败': 'Authorization failed to start',
  'WebSocket 连续重连失败，已暂停自动重连': 'WebSocket reconnect failed repeatedly, auto-reconnect paused',
  '等待 server_hello 超时，正在重连…': 'server_hello timeout, reconnecting…',
  // 引导
  'Mini 模式': 'Mini mode',
  '自定义布局': 'Custom layout',
  '完成，进入编辑模式': 'Done · enter edit mode',
  '<b>点最底部这一区域</b>把面板收成一行，再点一次展开。哪些模块留在 Mini 可在编辑模式里调整。': '<b>Click the bottom area</b> to collapse the panel to one line; click again to expand. Which modules stay in Mini is adjustable in edit mode.',
  '空闲时显示当前<b>时间</b>，工作时自动<b>计时</b>。点小球播一段动画。': 'Shows the current <b>time</b> when idle and <b>counts up</b> while working. Click the ball to play an animation.',
  '<span class="ksb-walk-hl">长按面板任意位置</span>进入编辑模式，拖动模块到不同区域改变显示方式；点模块右上角 <b>≡</b> 调宽度和专属设置。': '<span class="ksb-walk-hl">Long-press anywhere on the panel</span> to enter edit mode. Drag modules between zones; click <b>≡</b> on a module for width and per-module settings.',
  // 连接提示
  'WebSocket 连接建立超时，正在重试…': 'WebSocket connection timed out, retrying…',
  'WebSocket 连接失败': 'WebSocket connection failed',
  'WebSocket 已断开（{code}{reason}），正在重连…': 'WebSocket closed ({code}{reason}), reconnecting…',
  // 其他动态串
  '{date} · 主 {main} · 子 {sub}': '{date} · main {main} · sub {sub}',
  '赠送 {granted} · 充值 {paid}': 'Granted {granted} · Paid {paid}',
  '重置 {time}': 'Resets {time}',
  '宽度': 'Width',
  '余额点击跳转': 'Balance click link',
  /* ---------- popup ---------- */
  '当前': 'Current',
  '切换': 'Switch',
  '切换失败': 'Switch failed',
  '改名': 'Rename',
  '重新授权': 'Re-authorize',
  '移除': 'Remove',
  '移除失败': 'Remove failed',
  '保存': 'Save',
  '改名失败': 'Rename failed',
  '（需重新授权）': ' (needs reauth)',
  '{name}失败：{msg}': '{name} failed: {msg}',
  '改名失败：{msg}': 'Rename failed: {msg}',
  '移除失败：{msg}': 'Remove failed: {msg}',
  '获取失败：{msg}': 'Failed: {msg}',
  '请在授权页完成授权。': 'Complete authorization in the opened page.',
  '状态查询失败：{msg}': 'Status query failed: {msg}',
  '验证码：': 'Code: ',
  '已在新标签页打开授权页，请完成授权；关闭本弹窗不影响授权。': 'The authorization page opened in a new tab — complete it there; closing this popup does not affect the process.',
  '授权成功，状态栏会自动恢复显示。': 'Authorized. The status bar will resume automatically.',
  '授权未完成（已超时或被取消），请重试。': 'Authorization not completed (timed out or cancelled) — please retry.',
  '余额数据异常': 'Abnormal balance data',
  '窗口数据异常': 'Abnormal window data',
  '余额 {total}（赠送 {granted} · 充值 {paid}）': 'Balance {total} (granted {granted} · paid {paid})',
  '状态读取失败，请稍后刷新': 'Failed to read status, please refresh',
  '请先粘贴 API Key': 'Paste an API Key first',
  '正在验证…': 'Verifying…',
  '未授予域名访问权限': 'Domain access not granted',
  '保存失败': 'Save failed',
  '已保存': 'Saved',
  '累计命名 {calls} 次 · 输入 {input} · 输出 {output} tokens': 'Named {calls} times · input {input} · output {output} tokens',
  '尚未安装宠物': 'No pets installed',
  '下载中…': 'Downloading…',
  '安装成功，已切换为新宠物': 'Installed — switched to the new pet',
  '安装失败：{msg}': 'Install failed: {msg}',
  '已下载 ✓': 'Downloaded ✓',
  '下载失败': 'Download failed',
  '已复制 ✓': 'Copied ✓',
  '复制失败，请用下载': 'Copy failed — use download',
  '{date} · 无记录': '{date} · no record',
  '（主 {main} · 子 {sub}）': ' (main {main} · sub {sub})',
  '读取失败': 'Read failed',
  '读取失败：{msg}': 'Read failed: {msg}',
  '导出失败': 'Export failed',
  '导出统计': 'Export stats',
  '授权本地 CLI': 'Authorize local CLI',
  '正在读取本地记录 {pct}%': 'Reading local records {pct}%',
  '本地记录已授权': 'Local records authorized',
  '状态读取失败': 'Failed to read status',
  '连接状态异常，请重试': 'Connection abnormal, please retry',
  '本地记录读取失败': 'Failed to read local records',
  '当前 Chrome 不支持目录授权': 'This Chrome does not support directory access',
  '正在恢复授权…': 'Restoring access…',
  '请选择 .kimi-code 文件夹…': 'Choose the .kimi-code folder…',
  '目录选择错误：请选择 .kimi-code 文件夹。': 'Wrong folder: choose the .kimi-code folder.',
  '连接失败，请重试': 'Connection failed, please retry',
  '断开失败，请重试': 'Disconnect failed, please retry',
  '建议路径：<code>~/.kimi-code</code><br>目录选择器中按 <b>⌘⇧.</b> 显示隐藏目录。': 'Suggested path: <code>~/.kimi-code</code><br>Press <b>⌘⇧.</b> in the directory picker to show hidden folders.',
  '建议路径：<code>%USERPROFILE%\\.kimi-code</code><br>可按 <b>Ctrl+L</b> 后粘贴路径并回车。': 'Suggested path: <code>%USERPROFILE%\\.kimi-code</code><br>Press <b>Ctrl+L</b>, paste the path and press Enter.',
  '建议路径：<code>~/.kimi-code</code><br>目录选择器中按 <b>Ctrl+H</b> 显示隐藏目录。': 'Suggested path: <code>~/.kimi-code</code><br>Press <b>Ctrl+H</b> in the directory picker to show hidden folders.',
  // popup.html 静态串（applyPopupI18n 的叶子文本与属性）
  '统计指标': 'Stats metric',
  '活跃热力图': 'Activity heatmap',
  '起始日期': 'Start date',
  '结束日期': 'End date',
  '分享用量': 'Share usage',
  '取消': 'Cancel',
  '开启长期用量统计': 'Enable long-term usage stats',
  '授权读取本机 Kimi CLI 使用记录，用于7天、30天统计。不会保存或上传对话内容。': 'Authorize reading local Kimi CLI usage records for 7-day and 30-day stats. Conversation content is never saved or uploaded.',
  'Kimi 账户': 'Kimi accounts',
  '去授权': 'Authorize',
  '备注名（可留空，授权后可改）': 'Label (optional, editable after auth)',
  '+ 添加账户': '+ Add account',
  '粘贴 API Key': 'Paste API Key',
  '桌面宠物': 'Desktop pet',
  '+ 添加宠物': '+ Add pet',
  '粘贴宠物安装 bash 命令': 'Paste pet install bash command',
  '安装': 'Install',
  '宠物大小': 'Pet size',
  '重置': 'Reset',
  '放大': 'Enlarge',
  '缩小': 'Shrink',
  '新会话 AI 自动命名': 'AI auto-rename for new sessions',
  '使用模型': 'Model',
  '命名模型': 'Naming model',
  '标题带 emoji': 'Emoji in title',
  '打开': 'On',
  '检查更新': 'Check for updates',
  '推荐画廊：': 'Galleries: ',
  '用量分享卡片预览': 'Usage share card preview',
  '下载 PNG': 'Download PNG',
  '复制图片': 'Copy image',
  '面板额度条显示当前账户的 5 小时与本周额度。': "The panel quota bars show the current account's 5-hour and weekly quota.",
  '添加后，面板「外部账户」模块会显示对应余额/额度，Key 只保存在本机扩展存储中。': 'After adding, the panel "External accounts" module shows its balance/quota. Keys are stored only in local extension storage.',
  '到 codexpet.top 或 petdex.dev 挑选喜欢的宠物，复制它的安装命令（那段 bash），回到这里点「+ 添加宠物」粘贴即可。<br><br>宠物素材来自社区分享，其权利归属与使用限制以各发布页面为准；本扩展仅提供本地播放功能，不持有也不担保素材的任何权利。': 'Pick a pet at codexpet.top or petdex.dev, copy its install command (the bash snippet), and paste it here via "+ Add pet".<br><br>Pet assets are shared by the community; their rights and usage limits belong to the respective publishers. This extension only provides local playback and holds no rights to the assets.',
  '读取会话的首条与最近消息，由所选模型生成简短标题写回侧边栏；手动改过的名字不会被覆盖。<br><br>开启自动命名后，新会话在第 3 轮对话结束后才命名（首轮内容太少不足以概括）。<br><br>此功能会额外消耗 token：每次重命名输入约 1500~2500 tokens（上下文有 2000 字符硬上限），输出几十到几百 tokens。下方计数器显示累计消耗。': 'Reads the first and latest messages of a session and asks the selected model for a short title written back to the sidebar; manually renamed titles are never overwritten.<br><br>With auto-rename on, new sessions are named only after turn 3 (too little content earlier).<br><br>This feature consumes extra tokens: about 1500–2500 input tokens per rename (2,000-char context cap) and tens to hundreds of output tokens. The counter below shows the cumulative usage.',
  /* ---------- 收藏 + 分享卡片 ---------- */
  '已开启实验性「多标签页侧栏」，页面即将刷新以生效…': 'Enabled the experimental "Multi-tab sidebar"; refreshing the page to apply…',
  '[close]关闭': 'Close',
  '收藏': 'Bookmark',
  '取消收藏': 'Remove bookmark',
  'AI 回复': 'AI reply',
  '未命名会话': 'Untitled session',
  '按会话分组': 'Group by session',
  '最早在前': 'Oldest first',
  '最新在前': 'Newest first',
  '批量管理': 'Manage',
  '列表': 'List',
  '卡片': 'Cards',
  '全选': 'Select all',
  '删除所选（{n}）': 'Delete selected ({n})',
  '完成': 'Done',
  '暂无收藏内容。可在 AI 回复下方的操作栏中点击星标，将回复加入收藏。': 'No bookmarks yet. Click the star in the action bar below an AI reply to bookmark it.',
  '收藏详情': 'Bookmark detail',
  '用户提问': 'Your question',
  '（收藏时未记录提问）': '(question not recorded when bookmarked)',
  '跳转到原文 →': 'Jump to original →',
  '收藏目录': 'Bookmark outline',
  '导出收藏': 'Export bookmarks',
  '收藏导出': 'Bookmark export',
  '导出于 {date} · 共 {n} 条': 'Exported {date} · {n} items',
  // 分享卡片 SVG
  'Kimi Code 用量': 'Kimi Code Usage',
  '每日消耗': 'Daily usage',
  '缓存命中 {pct}%': 'Cache hit {pct}%',
  '峰值 {date} · {value}': 'Peak {date} · {value}',
  '活跃热力图 · {n} 天': 'Activity heatmap · {n}d',
  '范围汇总': 'Summary',
  '活跃天数': 'Active days',
  '{a} / {b} 天': '{a} / {b} d',
  '日均消耗': 'Daily average',
  '{v} / 天': '{v} / day',
  '峰值日': 'Peak day',
  '总消耗': 'Total',
  /* ---------- 动态站点授权 ---------- */
  '此站点未启用面板': 'Panel not enabled on this site',
  '已在此站点启用面板': 'Panel enabled on this site',
  '在此站点启用': 'Enable on this site',
  '重新启用': 'Re-enable',
  '未授予站点访问权限': 'Site access not granted',
  '启用失败': 'Failed to enable',
  '取消失败': 'Failed to disable',
  /* ---------- 扩展功能卡片（收藏开关 / 自动归档 / 自动命名） ---------- */
  '扩展功能': 'Extensions',
  'AI 回复收藏：点击 AI 回复下方的星标即可收藏，在侧栏随时回看；内容只保存在本地。<br><br>自动归档不活跃对话：按静默天数把不活跃的对话自动移入「已完成」，保持「进行中」列表干净。': 'AI reply bookmarks: click the star below an AI reply to bookmark it and revisit from the sidebar; content stays on this device.<br><br>Auto-archive inactive chats: moves inactive sessions to "Done" after their idle days threshold, keeping the "Open" list clean.',
  'AI 回复收藏': 'AI reply bookmarks',
  '自动归档不活跃对话': 'Auto-archive inactive chats',
  '没有符合条件的对话': 'No sessions match the rules',
  '点击解锁自动归档': 'Click to unlock auto-archive',
  '单日对话 = 创建后不到 2 天的短会话（当天一次性任务），静默达到天数即自动归档': 'Single-day = short sessions used within 2 days of creation (one-off tasks); archived automatically after the idle threshold.',
  '多日对话 = 跨 2 天以上持续使用的会话（隔几天回来一次），静默达到天数即自动归档': 'Multi-day = sessions used across more than 2 days (revisited every few days); archived automatically after the idle threshold.',
  '所有对话 = 不论活跃跨度，只要静默达到天数就自动归档（兜底规则）': 'Any session = regardless of active span, archived automatically once the idle threshold is reached (fallback rule).',
  '每 24 小时后台自动归档一次': 'Auto-archives in the background every 24 hours',
  '每 24 小时后台自动归档一次；上次：{time}，归档 {n} 个对话': 'Auto-archives every 24 hours; last run {time}, {n} sessions archived',
  '账户 {n}': 'Account {n}',
  '单日对话，静默': 'Single-day, idle ≥',
  '多日对话，静默': 'Multi-day, idle ≥',
  '所有对话，静默': 'Any session, idle ≥',
  '天后归档': 'days',
  '已改由官方实验「AI session titles」实现，未开启时点击复制提示词，发给 Kimi 即可开启。': 'Now powered by the official Kimi CLI experiment "AI session titles". If it is not enabled yet, click Copy prompt and send it to Kimi to switch on.',
  '复制提示词': 'Copy prompt',
  '已复制，粘贴到 kimi 对话框发送即可': 'Copied — paste it into the kimi chat and send',
  '复制失败，请手动操作': 'Copy failed — please copy manually',
  '重试': 'Retry',
  '清理并解锁自动归档': 'Archive them & unlock auto-archive',
  '……以及其他 {m} 个对话': '… and {m} more sessions',
  '有 {n} 条对话待归档': '{n} sessions ready to archive',
  '操作失败': 'Operation failed',
  '已解锁自动归档': 'Auto-archive unlocked',
  '操作失败：{msg}': 'Operation failed: {msg}',
  '已移入「已完成」{n} 个对话': 'Moved {n} sessions to "Done"',
  '正在读取会话列表…': 'Loading sessions…',
  '已开启 Kimi Web 实验性「多标签页侧栏」，页面即将刷新…': 'Enabled the Kimi Web experimental "Multi-tab sidebar"; refreshing the page…',
  '每 24 小时后台自动整理一次': 'Tidies automatically every 24 hours',
  '每 24 小时后台自动整理一次；上次：{time}，归档 {n} 个对话': 'Tidies automatically every 24 hours; last run {time}, {n} sessions archived'
};

export function getLocale() {
  return currentLocale;
}

// 从页面 localStorage 读取 Kimi Web 语言设置；返回是否发生了变化
export function syncLocaleFromPage() {
  let next = '';
  try {
    next = globalThis.localStorage?.getItem(PAGE_LOCALE_KEY) || '';
  } catch (error) {
    next = '';
  }
  if (next !== 'zh' && next !== 'en') {
    next = globalThis.navigator?.language?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  }
  const changed = next !== currentLocale;
  currentLocale = next;
  if (changed) {
    // 镜像给 popup（扩展页面读不到页面 localStorage）
    try {
      if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
        chrome.storage.local.set({ [LOCALE_MIRROR_STORAGE_KEY]: next }).catch(() => {});
      }
    } catch (error) {
      // 扩展上下文失效时忽略
    }
  }
  return changed;
}

// 翻译：英文取 EN 表，缺失回退中文原文；{var} 占位符替换。
// 上下文消歧：键可带 '[context]' 前缀（如 '[close]关闭'），中文显示取 ] 之后部分，
// 英文按完整键查表——解决「关闭」（Off/Close）这类同字不同义。
export function t(text, vars) {
  let zh = text;
  if (text.startsWith('[')) {
    const close = text.indexOf(']');
    if (close > 1) zh = text.slice(close + 1);
  }
  let out = currentLocale === 'en' ? EN[text] ?? zh : zh;
  if (vars) {
    for (const [key, value] of Object.entries(vars)) {
      out = out.replaceAll(`{${key}}`, String(value));
    }
  }
  return out;
}

// 面板状态文案（STATUS_TEXT 键 → 当前语言文案）
export function statusText(status) {
  return t(STATUS_TEXT[status] || status);
}

/* ---------- popup 侧：从镜像读取语言 + 静态 HTML 应用器 ---------- */

// popup 是扩展自有页面，读不到页面的 kimi-locale；读 content 镜像过来的键，
// 缺省回退浏览器语言。返回当前语言。
export async function initPopupLocale() {
  let next = '';
  try {
    if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
      const stored = await chrome.storage.local.get(LOCALE_MIRROR_STORAGE_KEY);
      next = stored[LOCALE_MIRROR_STORAGE_KEY] || '';
    }
  } catch (error) {
    next = '';
  }
  if (next !== 'zh' && next !== 'en') {
    next = globalThis.navigator?.language?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  }
  currentLocale = next;
  return next;
}

// 静态 HTML 应用器：翻译叶子元素的文本与常见属性；中文键原样返回，
// 所以 popup.html 保持中文源不动（已有断言的测试不受影响）
const I18N_ATTRS = ['title', 'placeholder', 'aria-label', 'value'];

export function applyPopupI18n(root) {
  if (currentLocale !== 'en') return;
  const doc = root || document;
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of I18N_ATTRS) {
      const value = el.getAttribute?.(attr);
      if (value && /[\u4e00-\u9fff]/.test(value)) el.setAttribute(attr, t(value));
    }
    // info-tip 等带 <br> 的长文：innerHTML 整体作为键
    if (el.classList?.contains('info-tip') && el.innerHTML) {
      el.innerHTML = t(el.innerHTML);
    }
  }
  // 纯文本节点（含「推荐画廊：」这类与链接混排的）：逐个文本节点翻译，保留首尾空白
  const walker = doc.createTreeWalker(doc.body || doc, 4 /* NodeFilter.SHOW_TEXT */);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue || '';
    if (!/[\u4e00-\u9fff]/.test(text)) continue;
    const lead = text.match(/^\s*/)[0];
    const tail = text.match(/\s*$/)[0];
    node.nodeValue = lead + t(text.trim()) + tail;
  }
}
