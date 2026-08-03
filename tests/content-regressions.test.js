const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(__dirname, '..', 'content.css'), 'utf8');

test('切换会话游标固定归零：服务端不补发历史，数据由快照与本地汇总恢复', () => {
  assert.match(source, /if \(sessionChanged\) \{[\s\S]*?lastSeq = 0;[\s\S]*?await loadSessionSnapshot/);
  assert.doesNotMatch(source, /sessionCursors/);
});

test('服务端快照成功时使用服务端累计；无本地恢复时才清空上一会话曲线', () => {
  assert.match(
    source,
    /if \(snapshotUsage && !snapshotLooksUnavailable\) \{[\s\S]*?metrics\.inputTokens[\s\S]*?if \(sessionChanged && !hasLocalState\) \{[\s\S]*?clearSessionHistory\(\);[\s\S]*?renderAll\(\);[\s\S]*?return;/
  );
  assert.doesNotMatch(source, /restoreSessionLocal/);
});

test('会话快照兼容新版 data 包装，并拒绝缺少 message_count 的全零空壳快照', () => {
  assert.match(source, /const data = body\?\.data[\s\S]*?\? body\.data : body;/);
  assert.match(source, /const snapshotLooksUnavailable =[\s\S]*?data\.last_seq[\s\S]*?totalInputTokens\(snapshotUsage\)/);
  assert.doesNotMatch(source, /snapshotLooksUnavailable =[\s\S]{0,180}data\.message_count/);
  assert.match(source, /if \(snapshotUsage && !snapshotLooksUnavailable\)/);
});

test('默认模式不再从插件存储恢复或写入会话历史', () => {
  assert.doesNotMatch(source, /session\.usage\.get/);
  assert.doesNotMatch(source, /type: 'usage\.record'/);
  assert.doesNotMatch(source, /type: 'usage\.turn'/);
  assert.doesNotMatch(source, /usageFromSessionRecord/);
});

test('切换会话时等待目标快照再替换画面，空壳快照由本地按会话汇总恢复', () => {
  assert.doesNotMatch(
    source,
    /if \(sessionChanged\) \{[\s\S]{0,700}?sessionSamples = \[\];[\s\S]{0,200}?await loadSessionSnapshot/
  );
  assert.match(source, /if \(sessionChanged && !hasLocalState\) \{[\s\S]*?await restoreSessionFromScan/);
  assert.match(source, /KimiCliUsage\.SESSIONS_STORAGE_KEY/);
  assert.match(source, /改由本地按会话汇总恢复/);
});

test('同页切换会话缓存面板状态，切回瞬时恢复且计时连续', () => {
  assert.match(source, /const panelSessionCache = new Map\(\)/);
  assert.match(source, /cachePanelState\(sessionId\)/);
  assert.match(source, /hasLocalState = restorePanelState\(nextSessionId\)/);
  assert.match(source, /petStatusSince = restoredPetStatusSince;/);
});

test('轮次结束后的重扫在空闲时刷新当前会话底数，忙碌时跳过', () => {
  assert.match(source, /function refreshSessionSeedFromScan\(\) \{[\s\S]*?petTurnActive[\s\S]*?return;/);
  assert.match(source, /if \(message\?\.type === 'cli\.usage\.updated'\) \{[\s\S]*?refreshSessionSeedFromScan\(\);/);
});

test('WebSocket 只维护当前页面样本，仍按序号避免重放重复', () => {
  assert.match(source, /Number\(message\.seq\) > lastUsageSeq/);
  assert.match(source, /turnSequence <= lastTurnSeq/);
  assert.match(source, /sessionSamples\.push\(/);
});

test('快照恢复完成前不允许路由轮询抢先连接 WebSocket', () => {
  assert.match(source, /let sessionSnapshotPending = false;/);
  assert.match(source, /sessionSnapshotPending = true;[\s\S]*?await loadSessionSnapshot/);
  assert.match(source, /if \(requestId === sessionRequestId\) sessionSnapshotPending = false;/);
  assert.match(source, /sessionId && token && !sessionSnapshotPending && !ws/);
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
  assert.match(source, /async function loadUsageDaily\(\{ refreshIfStale = false \} = \{\}\)/);
  assert.match(source, /refreshIfStale &&[\s\S]{0,260}?type: 'cli\.usage\.refresh'/);
});

test('宠物显示余额时即使其他额度模块隐藏也继续刷新', () => {
  assert.match(source, /modules\.pet\?\.show !== 'hidden' && modules\.pet\?\.stat === 'balance'/);
  assert.match(source, /return quotaVisible \|\| balanceVisible \|\| petBalanceVisible;/);
});

test('宠物 24h 消耗未授权时明确提示连接 CLI', () => {
  assert.match(source, /if \(!cliUsageConnected\) return '需连接 CLI';/);
});

test('宠物恢复 2.0.0 的命名动画架构，不再混用官网状态机', () => {
  assert.match(source, /const PET_IDLE_ANIM = 'paopao';/);
  assert.match(source, /const PET_LOADING_ANIM = 'loading';/);
  assert.match(source, /const PET_CLICK_ANIMS = \[/);
  assert.match(source, /autoplay: false/);
  assert.match(source, /petRive\.stop\(\);[\s\S]*?petRive\.play\(name\);/);
  assert.doesNotMatch(source, /PET_STATE_MACHINE|stateMachines:|stateMachineInputs\(/);
  assert.doesNotMatch(source, /petRive\.pause\(/);
});

test('Mini 缩放排除弹入动画，并扩充安全随机动作', () => {
  const togglePool = source.match(/const PET_TOGGLE_ANIMS = \[([\s\S]*?)\];/)?.[1] || '';
  const clickPool = source.match(/const PET_CLICK_ANIMS = \[([\s\S]*?)\];/)?.[1] || '';
  assert.doesNotMatch(togglePool, /'in'/);
  assert.doesNotMatch(clickPool, /'in'/);
  assert.match(source, /toggleMini\(\);[\s\S]{0,180}?petHandleToggle\(\);/);
  assert.ok((togglePool.match(/'/g) || []).length >= 12);
});

test('空闲时低频播放眨眼或侧看，完成后回到 paopao', () => {
  assert.match(source, /const PET_IDLE_AMBIENT_ANIMS = \['wink', 'look_right_stop'\];/);
  assert.match(source, /PET_IDLE_AMBIENT_MIN_MS = 8_000/);
  assert.match(source, /petMotion !== PET_IDLE_ANIM/);
  assert.match(source, /petPlayMotion\(name, \{ returnToBase: true \}\);/);
  assert.match(source, /if \(name === PET_IDLE_ANIM\) petScheduleIdleAmbient\(\);/);
});

test('工作状态只播放 loading，并在 one-shot 自然结束后续播', () => {
  assert.match(source, /return PET_ANSWER_STATUSES\.includes\(petStatus\) \? PET_LOADING_ANIM : PET_IDLE_ANIM;/);
  assert.match(source, /onStop: \(event\) => \{[\s\S]*?stopped\.includes\(petMotion\)[\s\S]*?petMotion === PET_LOADING_ANIM[\s\S]*?petPlayMotion\(PET_LOADING_ANIM\);/);
  assert.doesNotMatch(source, /dataset\.motion|ksb-pet-loading/);
  assert.doesNotMatch(cssSource, /ksb-pet-loading-ring|ksb-pet-loading/);
});

test('工具调用期间锁住调用中，直到全部 tool result 返回', () => {
  assert.match(source, /const TOOL_STATUS_MIN_MS = 1_500;/);
  assert.match(source, /let activeToolCalls = 0;/);
  assert.match(source, /function setAgentWorkStatus\(status\)[\s\S]*?activeToolCalls > 0 \|\| Date\.now\(\) < toolStatusUntil/);
  assert.match(source, /function beginToolStatus\(\)[\s\S]*?Date\.now\(\) \+ TOOL_STATUS_MIN_MS[\s\S]*?setAgentStatus\('executing'\);/);
  assert.match(source, /function finishToolStatus\(\)[\s\S]*?setTimeout\([\s\S]*?setAgentStatus\(deferredWorkStatus\)/);
  assert.match(source, /case 'tool\.call\.started':[\s\S]*?beginToolStatus\(\);/);
  assert.match(source, /case 'tool\.result':[\s\S]*?finishToolStatus\(\);/);
  assert.match(source, /case 'turn\.step\.completed':[\s\S]*?setAgentWorkStatus\(/);
});

test('所有状态最短显示 1.5 秒，挂起期间取最新状态', () => {
  assert.match(source, /const STATUS_MIN_DISPLAY_MS = 1_500;/);
  assert.match(source, /pendingDisplayStatus = display;/);
  assert.match(source, /if \(display === displayedAgentStatus\) \{/);
});

test('滞留的 agent/work 状态在轮次活动外不升级为忙碌', () => {
  assert.match(source, /if \(busy && !petTurnActive\) break;/);
  assert.match(source, /if \(!petTurnActive\) return;/);
});

test('订阅重放（ack 之前的事件）不改状态不播 Stars，历史重放只进折线样本', () => {
  assert.match(source, /message\.type === 'ack' \|\| message\.type === 'resync_required'/);
  assert.match(source, /if \(awaitingAck\) \{/);
  assert.match(source, /if \(replayIsHistory\) \{[\s\S]*?pushStepSample\(replayPayload\)/);
  assert.match(source, /replaySamplesExpected = sessionSamples\.length === 0;/);
  assert.match(source, /ackWatchdog = setTimeout/);
});

test('子代理总览模块：注册、渲染与实时状态标记', () => {
  assert.match(source, /function renderAgents\(\)/);
  assert.match(source, /agents: '子代理'/);
  assert.match(source, /agentTotals\[agentId\]/);
  assert.match(source, /activeSubagents\.add/);
  assert.match(source, /seedAgentsFromScan/);
});

test('volatile WebSocket 帧复用 durable seq 时不会被游标误删', () => {
  assert.match(source, /if \(message\.seq != null && message\.volatile !== true\)/);
  assert.doesNotMatch(source, /if \(message\.seq != null\) \{/);
});

test('宠物灰红外观独立于 Rive 动作，恢复时默认回蓝色', () => {
  assert.match(source, /status === 'offline' \|\| status === 'unauthorized'/);
  assert.match(source, /status === 'ratelimit'/);
  assert.match(source, /els\.petCanvas\.dataset\.appearance = petAppearanceForStatus\(petStatus\)/);
  assert.match(cssSource, /\.ksb-pet-canvas\[data-appearance="gray"\]/);
  assert.match(cssSource, /\.ksb-pet-canvas\[data-appearance="red"\]/);
});

test('Stars 只由同一会话的真实 turn 生命周期触发', () => {
  assert.match(source, /case 'turn\.started':[\s\S]*?petBeginTurn\(\);/);
  assert.match(source, /petTurnActive &&[\s\S]*?petTurnSessionId === sessionId &&[\s\S]*?Date\.now\(\) - petTurnSince > 1_000/);
  assert.match(source, /if \(!alreadyRecorded\) \{[\s\S]*?petCompleteTurn\(\);[\s\S]*?\}/);
  assert.match(source, /if \(sessionChanged\) \{[\s\S]*?petCancelTurn\(\);[\s\S]*?clearToolStatus\(\);[\s\S]*?\}/);
  assert.doesNotMatch(source, /PET_ANSWER_STATUSES\.includes\(previous\) && display === 'idle'/);
  assert.match(source, /petPlayMotion\(PET_DONE_ANIM, \{ returnToBase: true \}\)/);
  assert.match(source, /if \(display === petStatus\) \{[\s\S]*?petApplyAppearance\(\);[\s\S]*?return;/);
  assert.doesNotMatch(source, /nostars/);
});

test('销毁内容脚本时通过 walkthrough cleanup 移除引导及监听', () => {
  assert.match(source, /window\.KsbWalkthrough\?\.stop\?\.\(\)/);
  assert.doesNotMatch(source, /getElementById\('ksb-guide'\)/);
});
