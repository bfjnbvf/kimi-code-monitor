import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'content.js'), 'utf8');
const wsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'websocket-session.js'), 'utf8');
const renderSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'render.js'), 'utf8');
const petSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'pet-panel.js'), 'utf8');
const widgetSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'widget-structure.js'), 'utf8');
const sessionSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'session.js'), 'utf8');
const quotaSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'quota.js'), 'utf8');
const usageDailySource = fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'usage-daily.js'), 'utf8');
const panelStateSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'panel-state.js'), 'utf8');
const metricsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'metrics.js'), 'utf8');
const utilsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'utils.js'), 'utf8');
const bridgeSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'panel-app', 'bridge.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(__dirname, '..', 'content.css'), 'utf8');

test('切换会话游标固定归零：服务端不补发历史，数据由快照与本地汇总恢复', () => {
  assert.match(sessionSource, /if \(sessionChanged\) \{[\s\S]*?conn\.resetCursors\(\);[\s\S]*?await loadSessionSnapshot/);
  assert.match(wsSource, /lastSeq = 0;[\s\S]*?lastUsageSeq = -1;[\s\S]*?lastTurnSeq = -1;[\s\S]*?subscriptionCursor = 0;/);
  assert.doesNotMatch(source, /sessionCursors/);
});

test('服务端快照成功时使用服务端累计；无本地恢复时才清空上一会话曲线', () => {
  assert.match(
    sessionSource,
    /if \(snapshotUsage && !snapshotLooksUnavailable\) \{[\s\S]*?metrics\.inputTokens[\s\S]*?if \(sessionChanged && !hasLocalState\) \{[\s\S]*?clearSessionHistory\(\);[\s\S]*?renderAll\(\);[\s\S]*?return;/
  );
  assert.doesNotMatch(source, /restoreSessionLocal/);
});

test('会话快照兼容新版 data 包装，并拒绝缺少 message_count 的全零空壳快照', () => {
  assert.match(sessionSource, /const data = body\?\.data[\s\S]*?\? body\.data : body;/);
  assert.match(sessionSource, /const snapshotLooksUnavailable =[\s\S]*?data\.last_seq[\s\S]*?totalInputTokens\(snapshotUsage\)/);
  assert.doesNotMatch(sessionSource, /snapshotLooksUnavailable =[\s\S]{0,180}data\.message_count/);
  assert.match(sessionSource, /if \(snapshotUsage && !snapshotLooksUnavailable\)/);
});

test('默认模式不再从插件存储恢复或写入会话历史', () => {
  assert.doesNotMatch(source, /session\.usage\.get/);
  assert.doesNotMatch(source, /type: 'usage\.record'/);
  assert.doesNotMatch(source, /type: 'usage\.turn'/);
  assert.doesNotMatch(source, /usageFromSessionRecord/);
});

test('切换会话时等待目标快照再替换画面，空壳快照由本地按会话汇总恢复', () => {
  assert.doesNotMatch(
    sessionSource,
    /if \(sessionChanged\) \{[\s\S]{0,700}?sessionSamples = \[\];[\s\S]{0,200}?await loadSessionSnapshot/
  );
  assert.match(sessionSource, /if \(sessionChanged && !hasLocalState\) \{[\s\S]*?await restoreSessionFromScan/);
  assert.match(sessionSource, /KimiCliUsage\.SESSIONS_STORAGE_KEY/);
  assert.match(sessionSource, /改由本地按会话汇总恢复/);
});

test('同页切换会话缓存面板状态，切回瞬时恢复且计时连续', () => {
  assert.match(sessionSource, /const panelSessionCache = new Map\(\)/);
  assert.match(sessionSource, /cachePanelState\(currentSessionId\)/);
  assert.match(sessionSource, /hasLocalState = restorePanelState\(nextSessionId\)/);
  assert.match(sessionSource, /setPetStatusSince\(restoredPetStatusSince\);/);
});

test('轮次结束后的重扫在空闲时刷新当前会话底数，忙碌时跳过', () => {
  assert.match(sessionSource, /function refreshSessionSeedFromScan\(\) \{[\s\S]*?petTurnActive[\s\S]*?return;/);
  assert.match(source, /if \(message\?\.type === 'cli\.usage\.updated'\) \{[\s\S]*?refreshSessionSeedFromScan\(\);/);
});

test('WebSocket 只维护当前页面样本，仍按序号避免重放重复', () => {
  assert.match(wsSource, /seq > lastUsageSeq/);
  assert.match(wsSource, /turnSequence <= lastTurnSeq/);
  assert.match(panelStateSource, /sessionSamples\.push\(/);
});

test('快照恢复完成前不允许路由轮询抢先连接 WebSocket', () => {
  assert.match(sessionSource, /let sessionSnapshotPending = false;/);
  assert.match(sessionSource, /sessionSnapshotPending = true;[\s\S]*?await loadSessionSnapshot/);
  assert.match(sessionSource, /if \(requestId === sessionRequestId\) sessionSnapshotPending = false;/);
  assert.match(source, /getCurrentSessionId\(\) && getSessionToken\(\) && !isSnapshotPending\(\) && conn\.isIdle\(\)/);
});

test('长期统计只读取本地 CLI 缓存，不再读取 WebSocket usageDaily', () => {
  assert.match(source, /KimiCliUsage\.DAILY_STORAGE_KEY/);
  assert.match(source, /type: 'cli\.usage\.refresh'/);
  assert.doesNotMatch(source, /changes\.usageDaily/);
});

test('CLI 更新广播只重绘缓存，不会再次触发扫描循环', () => {
  assert.match(
    source,
    /message\?\.type === 'cli\.usage\.updated'[\s\S]{0,180}?loadUsageDaily\(\);/
  );
  assert.match(usageDailySource, /async function loadUsageDaily\(\{ refreshIfStale = false \} = \{\}\)/);
  assert.match(usageDailySource, /refreshIfStale &&[\s\S]{0,260}?type: 'cli\.usage\.refresh'/);
});

test('宠物显示余额时即使其他额度模块隐藏也继续刷新', () => {
  assert.match(panelStateSource, /modules\.pet\?\.show !== 'hidden' && modules\.pet\?\.stat === 'balance'/);
  assert.match(panelStateSource, /return quotaVisible \|\| balanceVisible \|\| petBalanceVisible;/);
});

test('宠物今日消耗未授权时明确提示（扩展提示连接 CLI，独立面板显示状态短词）', () => {
  assert.match(renderSource, /: t\('需连接 CLI'\);/);
  assert.match(renderSource, /STATUS_SHORT\[panel\.statusLevel\] \|\| STATUS_SHORT\.loading/);
});

test('宠物恢复 2.0.0 的命名动画架构，不再混用官网状态机', () => {
  assert.match(petSource, /const PET_IDLE_ANIM = 'paopao';/);
  assert.match(petSource, /const PET_LOADING_ANIM = 'loading';/);
  assert.match(petSource, /const PET_CLICK_ANIMS = \[/);
  assert.match(petSource, /autoplay: false/);
  assert.match(petSource, /petRive\.stop\(\);[\s\S]*?petRive\.play\(name\);/);
  assert.doesNotMatch(petSource, /PET_STATE_MACHINE|stateMachines:|stateMachineInputs\(/);
  assert.doesNotMatch(petSource, /petRive\.pause\(/);
});

test('Mini 缩放排除弹入动画，并扩充安全随机动作', () => {
  const togglePool = petSource.match(/const PET_TOGGLE_ANIMS = \[([\s\S]*?)\];/)?.[1] || '';
  const clickPool = petSource.match(/const PET_CLICK_ANIMS = \[([\s\S]*?)\];/)?.[1] || '';
  assert.doesNotMatch(togglePool, /'in'/);
  assert.doesNotMatch(clickPool, /'in'/);
  assert.match(widgetSource, /toggleMini\(\);[\s\S]{0,180}?petHandleToggle\(\);/);
  assert.ok((togglePool.match(/'/g) || []).length >= 12);
});

test('空闲时低频播放眨眼或侧看，完成后回到 paopao', () => {
  assert.match(petSource, /const PET_IDLE_AMBIENT_ANIMS = \['wink', 'look_right_stop'\];/);
  assert.match(petSource, /PET_IDLE_AMBIENT_MIN_MS = 8_000/);
  assert.match(petSource, /petMotion !== PET_IDLE_ANIM/);
  assert.match(petSource, /petPlayMotion\(name, \{ returnToBase: true \}\);/);
  assert.match(petSource, /if \(name === PET_IDLE_ANIM\) petScheduleIdleAmbient\(\);/);
});

test('工作状态只播放 loading，并在 one-shot 自然结束后续播', () => {
  assert.match(petSource, /return PET_ANSWER_STATUSES\.includes\(petStatus\) \? PET_LOADING_ANIM : PET_IDLE_ANIM;/);
  assert.match(petSource, /onStop: \(event\) => \{[\s\S]*?stopped\.includes\(petMotion\)[\s\S]*?petMotion === PET_LOADING_ANIM[\s\S]*?petPlayMotion\(PET_LOADING_ANIM\);/);
  assert.doesNotMatch(petSource, /dataset\.motion|ksb-pet-loading/);
  assert.doesNotMatch(cssSource, /ksb-pet-loading-ring|ksb-pet-loading/);
});

test('工具调用期间锁住调用中，直到全部 tool result 返回', () => {
  assert.match(wsSource, /const TOOL_STATUS_MIN_MS = 1_500;/);
  assert.match(wsSource, /let activeToolCalls = 0;/);
  assert.match(wsSource, /function setAgentWorkStatus\(status\)[\s\S]*?activeToolCalls > 0 \|\| Date\.now\(\) < toolStatusUntil/);
  assert.match(wsSource, /function beginToolStatus\(\)[\s\S]*?Date\.now\(\) \+ TOOL_STATUS_MIN_MS[\s\S]*?setAgentStatus\('executing'\);/);
  assert.match(wsSource, /function finishToolStatus\(\)[\s\S]*?setTimeout\([\s\S]*?setAgentStatus\(deferredWorkStatus\)/);
  assert.match(wsSource, /case 'tool\.call\.started':[\s\S]*?beginToolStatus\(\);/);
  assert.match(wsSource, /case 'tool\.result':[\s\S]*?finishToolStatus\(\);/);
  assert.match(wsSource, /case 'turn\.step\.completed':[\s\S]*?setAgentWorkStatus\(/);
});

test('所有状态最短显示 1.5 秒，挂起期间取最新状态', () => {
  assert.match(renderSource, /const STATUS_MIN_DISPLAY_MS = 1_500;/);
  assert.match(renderSource, /pendingDisplayStatus = display;/);
  assert.match(renderSource, /if \(display === displayedAgentStatus\) \{/);
});

test('滞留的 agent/work 状态在轮次活动外不升级为忙碌', () => {
  assert.match(wsSource, /if \(busy && !panel\.petTurnActive\) break;/);
  assert.match(sessionSource, /if \(!panel\.petTurnActive\) return;/);
});

test('订阅重放（ack 之前的事件）不改状态不播 Stars，历史重放只进折线样本', () => {
  assert.match(wsSource, /message\.type === 'ack' \|\| message\.type === 'resync_required'/);
  assert.match(wsSource, /if \(awaitingAck\) \{/);
  assert.match(wsSource, /if \(replayIsHistory\) \{[\s\S]*?pushStepSample\(replayPayload\)/);
  assert.match(wsSource, /replaySamplesExpected = sessionSamples\.length === 0;/);
  assert.match(wsSource, /ackWatchdog = setTimeout/);
});

test('外部账户：未适配的供应商只进模块设置清单，不占常规列表', () => {
  // 三类分类来自共享层；渲染侧只认「已接入」的，未适配的留给 ≡ 设置里的清单
  assert.match(widgetSource, /panel\.externalUnsupported/);
  assert.match(renderSource, /panel\.externalUnsupported\.length/);
  // 数据时间：面板直连是 60 秒一轮，用户要能看出"这是刚抓的还是十分钟前的"
  assert.match(renderSource, /function externalAgeText\(at\)/);
  // 失败沿用上次成功数字：类型前缀位置换成数字年龄；从未成功过才显示「获取失败」
  assert.match(renderSource, /provider\.error && !age\) return t\('获取失败'\)/);
});

test('子代理总览模块：注册、渲染与实时状态标记', () => {
  assert.match(renderSource, /function renderAgents\(\)/);
  assert.match(widgetSource, /agents: '子代理'/);
  // 主代理一行一个模型（置顶、带主章）；子代理按模型合并（同模型多实例一行 + ×N）
  assert.match(renderSource, /for \(const \{ model, totals \} of agentModelRows\('main'\)\)/);
  assert.match(renderSource, /subagentModelGroups\(hiddenAgents\)/);
  assert.match(renderSource, /\$\{label\}×\$\{group\.agents\.length\}/);
  // 合并只发生在展示层：数据层仍是逐「代理 × 模型」（agentModelRows 不合并）
  assert.match(panelStateSource, /export function subagentModelGroups/);
  assert.match(wsSource, /activeSubagents\.add/);
  assert.match(sessionSource, /seedAgentsFromScan/);
});

test('volatile WebSocket 帧复用 durable seq 时不会被游标误删', () => {
  assert.match(wsSource, /if \(message\.seq != null && message\.volatile !== true\)/);
  assert.doesNotMatch(wsSource, /if \(message\.seq != null\) \{/);
});

test('宠物灰红外观独立于 Rive 动作，恢复时默认回蓝色', () => {
  // 外观映射唯一：statusAppearance（metrics）是灯点与宠物球共用的那份
  assert.match(metricsSource, /function statusAppearance\(status\)[\s\S]*?'off'[\s\S]*?'warn'[\s\S]*?'sub'[\s\S]*?'idle'[\s\S]*?'work'/);
  // 宠物球把五档语义折进素材仅有的三套外观（灰/蓝/红）
  assert.match(petSource, /import \{ statusAppearance \} from '\.\.\/metrics\.js'/);
  assert.match(petSource, /const appearance = statusAppearance\(status\)/);
  assert.match(petSource, /appearance === 'off'\) return 'gray'/);
  assert.match(petSource, /appearance === 'warn'\) return 'red'/);
  assert.match(petSource, /panel\.els\.petCanvas\.dataset\.appearance = petAppearanceForStatus\(petStatus\)/);
  assert.match(cssSource, /\.ksb-pet-canvas\[data-appearance="gray"\]/);
  assert.match(cssSource, /\.ksb-pet-canvas\[data-appearance="red"\]/);
});

test('标题行 = 精简版宠物模块：数据口径与外观都共用同一份', () => {
  // 右侧口径：一份 STAT_DEFS，菜单选项从它派生（两个 ≡ 菜单永远一致）
  assert.match(renderSource, /export const STAT_DEFS = \{/);
  assert.match(renderSource, /export function statMenuOptions\(\)/);
  assert.match(widgetSource, /menuOpts\('stat', statMenuOptions\(\), header\.stat\)/);
  assert.match(widgetSource, /menuOpts\('stat', statMenuOptions\(\), mod\.stat\)/);
  // 渲染：标题行与宠物各调一次共享定义，没有第二套口径表
  assert.match(renderSource, /export function renderHeaderStat\(\)[\s\S]*?STAT_DEFS\[key\]/);
  assert.match(renderSource, /export function renderPetStats\(\)[\s\S]*?STAT_DEFS\[panel\.widgetConfig\.modules\.pet\?\.stat\]/);
  // 灯点类名来自共享映射（不是各自写死 ksb-<status>）
  assert.match(renderSource, /ksb-status-dot ksb-dot-\$\{statusAppearance\(display\)\}/);
  // 手动刷新小图标：内联 SVG、无边框、只在「加油包余额」口径出现；标题行贴数字
  // 左侧，宠物模块贴字段名右侧（与 10px 字段名同字号）
  assert.match(renderSource, /refreshable: true/);
  assert.match(renderSource, /label: '加油包余额',\n\s*display: '余额',/); // 菜单全名、面板简称
  assert.match(renderSource, /def\.refreshable \? `\$\{t\(def\.label\)\}（\$\{t\('手动刷新'\)\}）` : t\(def\.label\)/); // 菜单标「（手动刷新）」
  assert.match(widgetSource, /const REFRESH_ICON = '<svg class="ksb-stat-refresh-icon"/);
  assert.match(widgetSource, /class="ksb-stat-refresh" id="ksb-header-stat-refresh" title="\$\{t\('刷新余额'\)\}" hidden>\$\{REFRESH_ICON\}<\/button>\s*<span id="ksb-header-stat-text">/);
  assert.match(widgetSource, /<span class="ksb-quota-label" id="ksb-pet-label">\$\{t\('今日消耗'\)\}<\/span>\s*<button type="button" class="ksb-stat-refresh" id="ksb-pet-stat-refresh"/);
  // hidden 属性必须压过 display:inline-flex，否则图标在非余额口径也一直显形（踩过）
  assert.match(cssSource, /\.ksb-stat-refresh\[hidden\] \{\s*display: none;/);
  // 标题行药丸：右边距固定（auto 顶到行尾）、数额变长时向左生长、绝不越界
  assert.match(cssSource, /\.ksb-header-stat \{[\s\S]*?margin-left: auto;[\s\S]*?flex-shrink: 0;[\s\S]*?background: var\(--ksb-fill-2\);[\s\S]*?border-radius: 100px;/);
  // 药丸里是「字段名 + 数额」：字段名是第一个让位的（面板 ≤220px 整体隐藏，行内再挤
  // 就它自己先被压没），数额一步不让；名称同时进悬停提示，隐藏后信息不丢
  assert.match(widgetSource, /id="ksb-header-stat-label"/);
  assert.match(renderSource, /headerStatLabel\.textContent = t\(def\.display \|\| def\.label\)/);
  assert.match(cssSource, /\.ksb-header-stat-label \{[\s\S]*?flex: 0 100 auto;[\s\S]*?overflow: hidden;/);
  assert.match(cssSource, /@container \(max-width: 220px\) \{\s*\.ksb-header-stat-label \{ display: none; \}/);
  assert.doesNotMatch(widgetSource, /showBalance/); // 老开关已被口径选择取代
  assert.doesNotMatch(cssSource, /\.ksb-balance/); // 老药丸类名并入 .ksb-header-stat
});

test('「点击数据跳转」：标题行与宠物小球共用一份选项与出口', () => {
  // 出口唯一：utils.openDataLink，两处都调它（不许各写一遍 if/else）
  assert.match(utilsSource, /export function openDataLink\(link\)[\s\S]*?console[\s\S]*?subscription/);
  assert.match(petSource, /openDataLink\(panel\.widgetConfig\.modules\.pet\?\.ballLink\)/);
  assert.match(widgetSource, /openDataLink\(panel\.widgetConfig\.modules\.header\?\.dataLink\)/);
  // 选项表也共用一份（含「无跳转」，两边都能选）
  assert.match(renderSource, /export function dataLinkOptions\(\)[\s\S]*?'none'[\s\S]*?'console'[\s\S]*?'subscription'/);
  assert.match(widgetSource, /menuOpts\('dataLink', dataLinkOptions\(\), header\.dataLink\)/);
  assert.match(widgetSource, /menuOpts\('ballLink', dataLinkOptions\(\), mod\.ballLink/);
  // 菜单文案：不再是「余额点击跳转」
  assert.match(widgetSource, /t\('点击数据跳转'\)/);
  assert.doesNotMatch(widgetSource, /balanceLink/);
});

test('模块菜单宽度不累积：打开前先归零 left/top（shrink-to-fit 正反馈）', () => {
  assert.match(widgetSource, /menu\.style\.left = '0px';\s*menu\.style\.top = '0px';\s*menu\.innerHTML = moduleMenuHTML\(id\);/);
  assert.match(cssSource, /\.ksb-edit-menu \{[\s\S]*?max-width: 190px;/);
});

test('外部账户行的降级阶梯：前缀先没 → 名称尾省略 → 数字永不动', () => {
  // ① 面板过窄（≤160px）整体隐藏类型前缀
  assert.match(cssSource, /@container \(max-width: 160px\) \{\s*\.ksb-external-kind \{\s*display: none;/);
  // ① 行内挤压时数值区优先让位（shrink 100），区内前缀比数字先让（同样 100）
  assert.match(cssSource, /\.ksb-external-value \{[\s\S]*?flex: 0 100 auto;/);
  assert.match(cssSource, /\.ksb-external-kind \{[\s\S]*?flex: 0 100 auto;/);
  // ② 名称优先级最低：可收缩 + 尾部省略
  assert.match(cssSource, /\.ksb-external-name \{[\s\S]*?flex: 0 1 auto;[\s\S]*?text-overflow: ellipsis;/);
  // ③ 数字与单位不可动：shrink 0 + nowrap（没有省略号）
  assert.match(cssSource, /\.ksb-external-amount \{[\s\S]*?flex: 0 0 auto;[\s\S]*?white-space: nowrap;/);
  // 结构：前缀与数字各自成 span，否则 CSS 无法分层让位
  assert.match(renderSource, /<span class="ksb-external-kind">[\s\S]*?<span class="ksb-external-amount">/);
  assert.doesNotMatch(cssSource, /\.ksb-external-name \{[^}]*flex-shrink: 0;/); // 旧：名字永不收缩
  assert.doesNotMatch(cssSource, /\.ksb-external-value \{[^}]*text-overflow: ellipsis;/); // 数字不省略
});

test('两个数据位共用一个刷新入口：数据到达时标题行不许漏刷', () => {
  // 曾经只调 renderPetStats，标题行停在首帧的「统计中」直到进编辑模式才碰巧重建
  assert.match(renderSource, /export function renderStatSlots\(\) \{\s*renderHeaderStat\(\);\s*renderPetStats\(\);/);
  assert.match(bridgeSource, /renderStatSlots\(\);/); // 长期统计到达 → 两个数据位一起刷
  assert.match(usageDailySource, /renderStatSlots\(\);/); // 扩展侧同样
  // 数据到达路径上不许再有只刷宠物一个的调用点
  assert.doesNotMatch(bridgeSource, /(?<!Stat)renderPetStats\(\)/);
  assert.doesNotMatch(usageDailySource, /(?<!Stat)renderPetStats\(\)/);
});

test('Stars 只由同一会话的真实 turn 生命周期触发', () => {
  assert.match(wsSource, /case 'turn\.started':[\s\S]*?petBeginTurn\(\);/);
  assert.match(petSource, /panel\.petTurnActive &&[\s\S]*?petTurnSessionId === deps\.getSessionId\(\) &&[\s\S]*?Date\.now\(\) - petTurnSince > 1_000/);
  assert.match(wsSource, /if \(!alreadyRecorded\) \{[\s\S]*?petCompleteTurn\(\);[\s\S]*?\}/);
  assert.match(sessionSource, /if \(sessionChanged\) \{[\s\S]*?petCancelTurn\(\);[\s\S]*?conn\.clearToolStatus\(\);[\s\S]*?\}/);
  assert.doesNotMatch(source, /PET_ANSWER_STATUSES\.includes\(previous\) && display === 'idle'/);
  assert.match(petSource, /petPlayMotion\(PET_DONE_ANIM, \{ returnToBase: true \}\)/);
  assert.match(petSource, /if \(display === petStatus\) \{[\s\S]*?petApplyAppearance\(\);[\s\S]*?return;/);
  // 星星粒子由 nostars 退场链负责收回（自然结束与被打断两条路径都覆盖）
  assert.match(petSource, /PET_DONE_OUTRO_ANIM = 'nostars'/);
  assert.match(petSource, /petStarsVisible && petMotion !== PET_DONE_OUTRO_ANIM/);
});

test('销毁内容脚本时通过 walkthrough cleanup 移除引导及监听', () => {
  assert.match(source, /stopWalkthrough\(\)/);
  assert.doesNotMatch(source, /getElementById\('ksb-guide'\)/);
});

test('WS 重连重放：ack 后已实时处理的 step/turn 重放不再双算', () => {
  // 先捕获推进前的水位，再做 Math.max 推进
  assert.match(wsSource, /const prevUsageSeq = lastUsageSeq;[\s\S]*?const prevTurnSeq = lastTurnSeq;[\s\S]*?lastUsageSeq = Math\.max\(lastUsageSeq, replaySeq\)/);
  // 重放的 step/turn 只在游标大于旧水位时才累计
  assert.match(wsSource, /replaySeq > prevUsageSeq\)[\s\S]*?handleStepCompleted\(replayPayload, replayAgent\)/);
  assert.match(wsSource, /replaySeq > prevTurnSeq\)[\s\S]*?pushReplayedTurnDuration\(replayPayload\)/);
  // 重复的 turn.ended 不清工具状态、不复位工作状态
  assert.match(wsSource, /if \(!alreadyRecorded\) \{\s*clearToolStatus\(\);\s*setAgentStatus\('idle'\);/);
});

test('本地汇总 seed 恢复期间切换会话时丢弃旧会话结果', () => {
  assert.match(sessionSource, /const sid = currentSessionId;[\s\S]*?await readSessionSeed\(sid\)[\s\S]*?if \(!seed \|\| sid !== currentSessionId\) return;/);
});

test('切换账户后面板先显示该账户缓存额度，再强制刷新', () => {
  assert.match(source, /message\?\.type === 'auth\.switched'/);
  assert.match(source, /fetchQuota\(false, \{ allowStale: true \}\)/);
  assert.match(source, /fetchQuota\(true\)/);
  assert.match(quotaSource, /payload: \{ force, allowStale \}/);
});

test('侧栏改造开启时隐藏新建对话/搜索右端的快捷键提示（与收起按钮重叠）', () => {
  assert.match(cssSource, /html\.ksb-sidebar-tidy aside\.side \.sidebar-actions \.ui-kbd \{\s*display: none/);
});

test('侧栏头部存在 logo/收起按钮之外的可见内容（如 RC 设备选择器）时自动跳过侧栏改造（issue #8）', () => {
  // 安全闸：只允许 .ch-brand / .ch-collapse 及其祖先后代，其余可见元素即判定不安全
  assert.match(widgetSource, /function sidebarHeaderTidySafe\(\)/);
  assert.match(widgetSource, /for \(const selector of \['\.ch-brand', '\.ch-collapse'\]\)/);
  assert.match(widgetSource, /!allowed\.has\(el\) && el\.getClientRects\(\)\.length > 0/);
  assert.match(widgetSource, /pet\?\.show !== 'hidden' && sidebarHeaderTidySafe\(\)/);
  // 头部内容随 SPA 异步变化，路由轮询里持续重新评估
  assert.match(source, /if \(!ensureWidget\(\)\) return;[\s\S]{0,200}?applySidebarTidy\(\);/);
});

test('RC 设备选择器（.rc-dev）收缩到收起按钮同一行，右侧让出按钮位（issue #8）', () => {
  assert.match(cssSource, /html\.ksb-sidebar-tidy aside\.side \.rc-dev \{[\s\S]*?height: 26px;[\s\S]*?margin: 12px 46px 0 0;/);
  assert.match(cssSource, /html\.ksb-sidebar-tidy aside\.side \.rc-dev-trigger \{[\s\S]*?height: 26px;/);
});

test('加油包余额双读 boosterWallet/booster_wallet（API 字段改名回归守卫）', () => {
  const quotaSource = fs.readFileSync(new URL('../src/content/quota.js', import.meta.url), 'utf8');
  assert.match(quotaSource, /boosterWallet( |\n)*\?\?( |\n)*response\.data\?\.booster_wallet/);
});

test('独立面板（桌面客户端注入）的宠物 ≡ 菜单不显示「侧栏改造」死开关', () => {
  // standaloneMode 下 applySidebarTidy 强制不生效，菜单同步隐藏该项；网页端保留
  assert.match(widgetSource, /const tidyRow = id === 'pet' && !panel\.standaloneMode/);
  assert.match(widgetSource, /menuOpts\('sidebarTidy', \[\[true, t\('开启'\)\], \[false, t\('关闭'\)\]\]/);
  assert.match(widgetSource, /\$\{statRow\}\s*\$\{tidyRow\}/);
});

test('收藏域不在 RC 远程静态站点初始化（远程页面不得通过侧栏读取收藏正文）', () => {
  assert.match(source, /import \{ isRemoteControl \} from '\.\/content\/utils\.js'/);
  assert.match(
    source,
    /function startBookmarks\(\) \{[\s\S]*?isRemoteControl\(\) \|\| location\.hostname === 'code-rc\.kimi\.com'[\s\S]*?return;/
  );
});
