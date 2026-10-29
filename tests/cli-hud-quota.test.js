import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeQuota, fetchQuota } from '../src/cli-hud/quota-worker.mjs';
import { callHud, node } from './helpers/hud-node.js';

test('quota adapters accept native, modern official and repository legacy shapes', () => {
  const expected = { fiveHour: { percent: 25, resetAt: null }, week: { percent: 80, resetAt: null } };
  assert.deepEqual(normalizeQuota({ data: { quota: { usages: { limit5h: { usedRatio: .25 }, limit7d: { usedRatio: .8 } } } } }), expected);
  assert.deepEqual(normalizeQuota({ usages: { limit_5h: { used_ratio: '.25' }, limit_7d: { used_ratio: .8 } } }), expected);
  assert.deepEqual(normalizeQuota({ limits: [{ window: { duration: '300' }, detail: { limit: 100, used: 25 } }], usage: { limit: 100, remaining: 20 } }), expected);
  assert.equal(normalizeQuota({}), null);
  assert.equal(normalizeQuota({ usages: { limit_5h: { used_ratio: '' } } }), null);
});

test('official fetch uses the authorized endpoint and does not turn an empty Free response into zero', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kcm-quota-'));
  try {
    fs.mkdirSync(path.join(home, 'credentials'));
    fs.writeFileSync(path.join(home, 'credentials', 'kimi-code.json'), JSON.stringify({ access_token: 'fixture-access-token' }));
    const result = await fetchQuota(home, async (url, init) => {
      assert.equal(url, 'https://api.kimi.com/coding/v1/usages');
      assert.equal(init.headers.Authorization, 'Bearer fixture-access-token');
      assert.equal(init.redirect, 'error');
      return { ok: true, status: 200, json: async () => ({}) };
    });
    assert.deepEqual(result, { status: 'no_quota', source: 'official-kimi', quota: null });
    assert.doesNotMatch(JSON.stringify(result), /fixture-access-token/);
    const expired = await fetchQuota(home, async () => ({ ok: false, status: 401 }));
    assert.equal(expired.status, 'auth_required');
  } finally { fs.rmSync(home, { recursive: true }); }
});

test('quota cache distinguishes fresh, stale, expired and empty states', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kcm-quota-cache-'));
  try {
    const dir = path.join(home, 'hud', 'kimi-code-monitor');
    fs.mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const file = path.join(dir, 'quota.json');
    const quota = { fiveHour: { percent: 25 }, week: null };
    fs.writeFileSync(file, JSON.stringify({ quota, fetchedAt: now, updatedAt: now, status: 'ok' }));
    assert.deepEqual(callHud('read_quota', home), { ...quota, stale: false });
    fs.writeFileSync(file, JSON.stringify({ quota, fetchedAt: now - 120000, updatedAt: now, status: 'ok' }));
    assert.equal(callHud('read_quota', home).stale, true);
    fs.writeFileSync(file, JSON.stringify({ quota, fetchedAt: now - 310000, updatedAt: now, status: 'ok' }));
    assert.equal(callHud('read_quota', home), null);
    fs.writeFileSync(file, JSON.stringify({ quota: null, fetchedAt: now, updatedAt: now, status: 'no_quota' }));
    assert.deepEqual(callHud('read_quota', home), { empty: true });
    fs.writeFileSync(file, JSON.stringify({ quota: null, updatedAt: now, status: 'auth_required' }));
    assert.deepEqual(callHud('read_quota', home), { authRequired: true });
  } finally { fs.rmSync(home, { recursive: true }); }
});

test('installed color override survives NO_COLOR and distinguishes empty quota', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kcm-quota-display-'));
  const payload = { model: 'DeepSeek V4.1 Flash', permissionMode: 'yolo', gitBranch: 'codex/hud-demo', contextTokens: 25000, maxContextTokens: 977000 };
  try {
    const dir = path.join(home, 'hud', 'kimi-code-monitor');
    fs.mkdirSync(dir, { recursive: true });
    for (const quota of [{ fiveHour: { percent: 25 }, week: { percent: 81 } }, null]) {
      const now = Date.now();
      fs.writeFileSync(path.join(dir, 'quota.json'), JSON.stringify({ quota, fetchedAt: now, updatedAt: now, status: quota ? 'ok' : 'no_quota' }));
      const result = spawnSync(node, ['dist/hud.cjs', '--no-wire', '--width', '120', '--color', 'always', '--modules', 'status,quota5h,quotaWeek,model,quotaStatus'],
        { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, KIMI_CODE_HOME: home, NO_COLOR: '1' } });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /\x1b\[1;38;2;/);
      // 空额度文案按运行时终端宽度在「暂无 / 额度暂无」间降级；测试不锁死终端宽度
      assert.match(result.stdout, quota ? /25%/ : /(额度)?暂无/);
      // 真实额度按填充比例显示八分格：▏▎▍▌▋▊▉ 均可
      if (quota) assert.match(result.stdout, /[▏▎▍▌▋▊▉]/);
      if (!quota) assert.match(result.stdout, /░{3,4}.*--%/);
      assert.doesNotMatch(result.stdout, /K DeepSeek/);
      assert.doesNotMatch(result.stdout, / │ /);
    }
  } finally { fs.rmSync(home, { recursive: true }); }
});

test('eval entry preserves CLI options and finds the quota worker beside the bundle', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kcm-hud-eval-'));
  try {
    const script = path.join(temp, 'hud.cjs');
    fs.copyFileSync('dist/hud.cjs', script);
    const worker = path.join(temp, 'worker.mjs');
    fs.writeFileSync(worker, "import fs from 'node:fs'; import path from 'node:path'; const at = process.argv.indexOf('--home'); fs.writeFileSync(path.join(process.argv[at + 1], 'worker-started'), 'ok');\n");
    fs.writeFileSync(path.join(temp, 'quota-worker.json'), JSON.stringify({ node, script: worker }));
    const home = path.join(temp, 'home');
    const cache = path.join(home, 'hud', 'kimi-code-monitor');
    fs.mkdirSync(cache, { recursive: true });
    const now = Date.now();
    fs.writeFileSync(path.join(cache, 'quota.json'), JSON.stringify({ quota: { fiveHour: { percent: 25 }, week: { percent: 75 } }, fetchedAt: now, updatedAt: 0, status: 'ok' }));
    const result = spawnSync(node, ['-e', `require(${JSON.stringify(script)})`, '--', '--no-wire', '--width', '58', '--plain', '--modules', 'status,model,quotaPair'], {
      input: JSON.stringify({ model: 'Eval Node HUD', permissionMode: 'manual' }), encoding: 'utf8',
      env: { ...process.env, KIMI_CODE_HOME: home, KIMI_CODE_STATUS_LINE: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Eval Node …/);
    assert.match(result.stdout, /5h\/7d/);
    assert.doesNotMatch(result.stdout, /缓存/);
    let started = false;
    for (let i = 0; i < 100; i++) {
      if (fs.existsSync(path.join(home, 'worker-started'))) { started = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(started, 'quota worker should start from the eval-loaded bundle path');
  } finally { fs.rmSync(temp, { recursive: true }); }
});
