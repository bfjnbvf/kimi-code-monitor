import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeQuota, fetchQuota } from '../src/cli-hud/quota-worker.mjs';
import { callHud, python } from './helpers/hud-python.js';

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
      const result = spawnSync(python, ['-I', '-S', 'src/cli-hud/hud.py', '--no-wire', '--width', '120', '--color', 'always'],
        { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, KIMI_CODE_HOME: home, NO_COLOR: '1' } });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /\x1b\[1;38;2;/);
      assert.match(result.stdout, quota ? /25%/ : /额度暂无/);
      assert.match(result.stdout, /▎/);
      if (!quota) assert.match(result.stdout, /░{4}.*--%/);
      assert.doesNotMatch(result.stdout, /K DeepSeek/);
      assert.doesNotMatch(result.stdout, / │ /);
    }
  } finally { fs.rmSync(home, { recursive: true }); }
});
