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

test('native counts override stale ratios and future fields do not affect rendering', () => {
  const line = callHud('render', payload, {}, 120, false);
  assert.match(line, /10%/);
  assert.equal(callHud('render', { ...payload, future: true }, {}, 120, false), line);
  assert.match(callHud('render', {}, {}, 120, false), /--%/);
  assert.doesNotMatch(line, /^K | │ /);
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

test('windowed layouts retain context and quota within the available columns', () => {
  for (const width of [20, 40, 58, 78, 98, 120]) {
    const activity = { thinkingEffort: 'high', quota: { authRequired: true } };
    const line = callHud('render', payload, activity, width, false);
    assert.ok(callHud('cell_width', line) <= width, `${width}: ${line}`);
    assert.match(line, /^Ctx /);
    if (width >= 40) assert.match(line, /Kimi /);
    if (width >= 78) {
      assert.match(line, /思考 high/);
      assert.match(line, /需登录$/);
    }
  }
});

test('pending approval survives tool completion and turn end clears it', () => {
  const rows = [{ type: 'turn.prompt' }, { type: 'context.append_loop_event', event: { type: 'tool.call', name: 'Read', toolCallId: 'a' } }, { type: 'interaction.request', id: 'approval' }, { type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: 'a' } }];
  assert.equal(callHud('parse_activity', jsonl(rows)).status, '等待确认');
  rows.push({ type: 'turn.ended', reason: 'completed' });
  assert.equal(callHud('parse_activity', jsonl(rows)).status, '已完成');
});

test('session lookup ignores incomplete records and never selects a different session', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kcm-hud-wire-'));
  try {
    const file = path.join(home, 'sessions', 'wd_demo', 'session_demo', 'agents', 'main', 'wire.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x'.repeat(512 * 1024 + 32) + '\n' + jsonl([{ type: 'turn.ended', reason: 'cancelled' }]) + '{"type":"turn.prompt"');
    assert.equal(callHud('read_activity', home, 'session_demo').status, '已停止');
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
  } finally { fs.rmSync(dir, { recursive: true }); }
});
