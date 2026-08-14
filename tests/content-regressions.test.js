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

test('宠物 24h 消耗未授权时明确提示连接 CLI', () => {
  assert.match(renderSource, /if \(!panel\.cliUsageConnected\) return '需连接 CLI';/);
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

test('子代理总览模块：注册、渲染与实时状态标记', () => {
  assert.match(renderSource, /function renderAgents\(\)/);
  assert.match(widgetSource, /agents: '子代理'/);
  assert.match(renderSource, /agentTotals\[agentId\]/);
  assert.match(wsSource, /activeSubagents\.add/);
  assert.match(sessionSource, /seedAgentsFromScan/);
});

test('volatile WebSocket 帧复用 durable seq 时不会被游标误删', () => {
  assert.match(wsSource, /if \(message\.seq != null && message\.volatile !== true\)/);
  assert.doesNotMatch(wsSource, /if \(message\.seq != null\) \{/);
});

test('宠物灰红外观独立于 Rive 动作，恢复时默认回蓝色', () => {
  assert.match(petSource, /status === 'offline' \|\| status === 'unauthorized'/);
  assert.match(petSource, /status === 'ratelimit'/);
  assert.match(petSource, /panel\.els\.petCanvas\.dataset\.appearance = petAppearanceForStatus\(petStatus\)/);
  assert.match(cssSource, /\.ksb-pet-canvas\[data-appearance="gray"\]/);
  assert.match(cssSource, /\.ksb-pet-canvas\[data-appearance="red"\]/);
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
