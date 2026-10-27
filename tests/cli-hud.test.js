import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { callHud, python } from './helpers/hud-python.js';
import { compatibleVersion, configure, restore, shellCommand, probe } from '../scripts/install-cli-hud.mjs';

const payload = { model: 'DeepSeek V4.1 Flash', cwd: 'C:/work/中文项目', gitBranch: 'codex/hud-demo', permissionMode: 'manual', contextTokens: 26214, maxContextTokens: 262144, contextUsage: .8 };
const jsonl = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n';

test('context payload is not rendered and status, model, thinking and permission precede the quota pair', () => {
  const activity = { quota: { fiveHour: { percent: 25 }, week: { percent: 75 } } };
  const line = callHud('render', payload, activity, 120, false);
  assert.match(line, /5h\/7d.*25%.*75%/);
  assert.match(line, /^● DeepSeek V4\.1 Flash 思考 -- 询问    5h\/7d/);
  assert.match(line, /缓存 --% 上轮--    中文项目/);
  assert.ok(line.indexOf('●') < line.indexOf('DeepSeek'));
  assert.ok(line.indexOf('DeepSeek') < line.indexOf('思考'));
  assert.ok(line.indexOf('思考') < line.indexOf('询问'));
  assert.ok(line.indexOf('询问') < line.indexOf('5h/7d'));
  assert.doesNotMatch(line, /Ctx/);
  assert.equal(callHud('render', { ...payload, future: true }, activity, 120, false), line);
  const empty = callHud('render', {}, {}, 120, false);
  assert.match(empty, /5h\/7d.*--%.*--%/);
});

test('model name and status light share the web panel appearance in every state', () => {
  const cases = [
    ['idle', '38;2;139;153;173'],
    ['thinking', '38;2;132;210;255'],
    ['executing', '38;2;132;210;255'],
    ['replying', '38;2;132;210;255'],
    ['subagent', '38;2;113;210;166'],
    ['ratelimit', '38;2;239;194;111'],
    ['offline', '38;2;255;126;145'],
  ];
  for (const [status, color] of cases) {
    const line = callHud('render', payload, { status }, 120, true);
    assert.ok(line.startsWith(`\x1b[${color}m●\x1b[0m \x1b[1;${color}mDeepSeek`), status);
  }
  const empty = callHud('render', payload, {}, 120, true);
  assert.ok(empty.startsWith('\x1b[38;2;139;153;173m●\x1b[0m \x1b[1;38;2;139;153;173mDeepSeek'));
  const unauthorized = callHud('render', payload, { status: 'thinking', quota: { authRequired: true } }, 120, true);
  assert.ok(unauthorized.startsWith('\x1b[38;2;255;126;145m●\x1b[0m \x1b[1;38;2;255;126;145mDeepSeek'));
});

test('latest usage includes both cache types exactly once', () => {
  assert.deepEqual(callHud('usage_bucket', { inputOther: 100, inputCacheRead: 900, inputCacheCreation: 50, output: 40 }), { input: 1050, output: 40, cacheRead: 900 });
});

test('thinking follows this session config changes, including off, and ignores subagents', () => {
  const rows = [
    { type: 'profile.bind', thinkingEffort: 'high' },
    { type: 'config.update', thinkingEffort: 'off' },
    { type: 'config.update', agentId: 'child', thinkingEffort: 'max' },
  ];
  const activity = callHud('parse_activity', jsonl(rows));
  assert.equal(activity.thinkingEffort, 'off');
  assert.match(callHud('render', payload, activity, 120, false), /思考 off/);
  assert.match(callHud('render', { ...payload, thinkingEffort: 'max' }, activity, 120, false), /思考 max/);
});

test('a global thinking default never stands in for an unsaved live selection', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kcm-hud-thinking-'));
  try {
    fs.writeFileSync(path.join(home, 'config.toml'), '[thinking]\nenabled = true\neffort = "high"\n');
    const result = spawnSync(python, ['-I', '-S', 'src/cli-hud/hud.py', '--no-quota', '--plain'], {
      input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, KIMI_CODE_HOME: home },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /思考 --/);
    assert.doesNotMatch(result.stdout, /思考 high/);
  } finally { fs.rmSync(home, { recursive: true }); }
});

test('windowed layouts keep the quota pair and model/status order within the available columns', () => {
  for (const width of [20, 40, 58, 78, 98, 120]) {
    const activity = { thinkingEffort: 'high', quota: { authRequired: true } };
    const line = callHud('render', payload, activity, width, false);
    assert.ok(callHud('cell_width', line) <= width, `${width}: ${line}`);
    assert.match(line, /^●/);
    assert.ok(line.indexOf('●') < line.indexOf('D'));
    assert.doesNotMatch(line, /Ctx|Kimi /);
    assert.ok((line.match(/--%/g) || []).length >= 2, '两个额度始终保留未知占位');
    if (width >= 40) assert.match(line, /5h\/7d/);
    if (width >= 78) assert.match(line, /思考 high/);
  }
});

test('module selection, ordering, duration, cache rate and optional metrics', () => {
  const rows = [
    { type: 'context.append_loop_event', event: { type: 'step.end', llmStreamDurationMs: 2000, usage: { output: 50 } } },
    { type: 'usage.record', usage: { inputOther: 25, inputCacheRead: 50, inputCacheCreation: 25, output: 50 } },
    { type: 'turn.ended', reason: 'completed', durationMs: 8400 },
  ];
  const activity = callHud('parse_activity', jsonl(rows));
  assert.equal(activity.durationMs, 8400);
  assert.equal(activity.speed, 25);
  const normal = callHud('render', payload, activity, 120, false);
  assert.match(normal, /缓存 50%/);
  assert.match(normal, /上轮8\.4s/);
  const custom = callHud('render', payload, activity, 120, false, ['branch', 'output', 'input', 'speed', 'cache', 'duration']);
  assert.match(custom, /^hud-demo/);
  assert.match(custom, /输出 50/);
  assert.match(custom, /输入 100/);
  assert.match(custom, /25\.0 tok\/s/);
  assert.doesNotMatch(custom, /5h|周 /);
  assert.deepEqual(callHud('module_options', ['--modules', 'model,input', '--order', 'input,model']), ['input', 'model']);
  assert.match(callHud('render', payload, { quota: { authRequired: true } }, 120, false, ['quotaStatus']), /需登录/);
});

test('waiting and every turn ending use idle like the web panel', () => {
  const rows = [{ type: 'turn.prompt' }, { type: 'context.append_loop_event', event: { type: 'tool.call', name: 'Read', toolCallId: 'a' } }, { type: 'interaction.request', id: 'approval' }, { type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: 'a' } }];
  assert.equal(callHud('parse_activity', jsonl(rows)).status, 'idle');
  for (const reason of ['completed', 'cancelled', 'failed', 'blocked', 'unknown']) {
    assert.equal(callHud('parse_activity', jsonl([...rows, { type: 'turn.ended', reason }])).status, 'idle', reason);
  }
});

test('tail-only tool and step events still infer an active turn', () => {
  const toolRows = [
    { type: 'context.append_loop_event', event: { type: 'tool.call', name: 'Read', toolCallId: 'a' } },
    { type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: 'a' } },
  ];
  assert.equal(callHud('parse_activity', jsonl(toolRows)).status, 'thinking');
  const stepRows = [{ type: 'context.append_loop_event', event: { type: 'step.end', llmStreamDurationMs: 2000, usage: { output: 50 } } }];
  assert.equal(callHud('parse_activity', jsonl(stepRows)).status, 'thinking');
});

test('subagent, rate limit and work status events follow the web state machine', () => {
  const rows = [
    { type: 'turn.prompt' },
    { type: 'subagent.spawned', payload: { subagentId: 'agent-1' } },
  ];
  assert.equal(callHud('parse_activity', jsonl(rows)).status, 'subagent');
  rows.push({ type: 'subagent.completed', payload: { subagentId: 'agent-1' } });
  assert.equal(callHud('parse_activity', jsonl(rows)).status, 'thinking');
  rows.push({ type: 'error', payload: { code: 'provider.rate_limit' } });
  assert.equal(callHud('parse_activity', jsonl(rows)).status, 'ratelimit');
  rows.push({ type: 'agent.status.updated', payload: { status: 'waiting' } });
  assert.equal(callHud('parse_activity', jsonl(rows)).status, 'idle');
  rows.push({ type: 'agent.status.updated', payload: { status: 'working' } });
  assert.equal(callHud('parse_activity', jsonl(rows)).status, 'thinking');
  rows.push({ type: 'event.session.work_changed', payload: { busy: false } });
  assert.equal(callHud('parse_activity', jsonl(rows)).status, 'idle');
});

test('session lookup ignores incomplete records and never selects a different session', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kcm-hud-wire-'));
  try {
    const file = path.join(home, 'sessions', 'wd_demo', 'session_demo', 'agents', 'main', 'wire.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x'.repeat(512 * 1024 + 32) + '\n' + jsonl([{ type: 'turn.ended', reason: 'cancelled' }]) + '{"type":"turn.prompt"');
    assert.equal(callHud('read_activity', home, 'session_demo').status, 'idle');
    assert.deepEqual(callHud('read_activity', home, 'session_other'), {});
  } finally { fs.rmSync(home, { recursive: true }); }
});

test('installer accepts stable Kimi 2.2+ and preserves unrelated config on restore', () => {
  for (const v of ['2.2.0', '2.3.0', '3.0.0']) assert.ok(compatibleVersion(v));
  assert.equal(compatibleVersion('2.1.9'), false);
  const before = '# keep\r\ntheme="light"\r\n[status_line]\r\ncommand = \'old command\' # keep\r\n[future]\r\na=1\r\n';
  const next = configure(before, 'new command');
  assert.equal(restore(next.text, next), before);
  assert.throws(() => restore(next.text.replace('new command', 'user command'), next), /changed/);
});

test('real entry emits one colored line and rejects invalid stdin', () => {
  const result = spawnSync(python, ['-I', '-S', 'src/cli-hud/hud.py', '--no-quota', '--color', 'always'], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\x1b\[1;38;2;/);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  const malformed = spawnSync(python, ['-I', '-S', 'src/cli-hud/hud.py'], { input: 'bad json', encoding: 'utf8' });
  assert.equal(malformed.status, 1);
  assert.equal(malformed.stdout, '');
});

test('Kimi shell command works from paths with spaces and Chinese', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcm hud 中文 '));
  try {
    const script = path.join(dir, 'hud.py');
    fs.copyFileSync('src/cli-hud/hud.py', script);
    // 功能测试不与并行测试争抢 300ms；独立验证保留原时限。
    // Functional tests allow contention; hud:verify retains the native 300ms deadline.
    assert.ok(await probe(shellCommand(python, script), 5000) < 5000);
    const custom = shellCommand(python, script, 120, process.platform, 'status,model,quotaPair', 'model,status,quotaPair');
    assert.match(custom, /--modules status,model,quotaPair --order model,status,quotaPair/);
    assert.ok(await probe(custom, 5000) < 5000);
    assert.throws(() => shellCommand(python, script, 120, process.platform, 'status,model;bad'), /comma-separated/);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
