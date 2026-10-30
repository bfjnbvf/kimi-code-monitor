// 发版纪律守卫：版本号三处一致 + CHANGELOG 顶部条目对应当前版本。
// 漏改任何一处，npm test 直接失败（发版流程见 docs/HANDOFF.md §八）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const maintenance = fs.readFileSync(path.join(ROOT, 'skill', 'MAINTENANCE.md'), 'utf8');
const legacyMaintenance = fs.readFileSync(path.join(ROOT, 'skill', 'MAINTENANCE'), 'utf8');
const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');

const maintenanceField = (name) => {
  const m = maintenance.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'));
  assert.ok(m, `skill/MAINTENANCE.md 缺少 ${name} 字段`);
  return m[1].trim();
};

const topUpdateEntry = () => {
  const m = maintenance.match(/^## ([\d.]+)（/m);
  assert.ok(m, 'skill/MAINTENANCE.md 缺少更新记录条目（## N（date））');
  return m[1];
};

const topPatchEntry = () => {
  const m = maintenance.match(/^## [\d.]+（[^\n]+）\n\n配套补丁 ([\d.]+)：/m);
  assert.ok(m, 'skill/MAINTENANCE.md 顶部条目缺少配套补丁版本');
  return m[1];
};

const topChangelogVersion = () => {
  const m = changelog.match(/^## (v[\d.]+)/m);
  assert.ok(m, 'CHANGELOG.md 缺少版本条目（## vX.Y.Z（date））');
  return m[1];
};

const isOfficialReleaseDownload = (value) => {
  if (/\\|%2f|%5c|\.\.|%2e/i.test(value)) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === 'https:' && url.host === 'github.com' && !url.username && !url.password &&
    /^\/bfjnbvf\/kimi-code-monitor\/releases\/download\/[^/]+\/[^/]+$/.test(url.pathname);
};

test('发版守卫：manifest 与 package.json 版本一致', () => {
  assert.equal(manifest.version, pkg.version);
});

test('发版守卫：package-lock 两处版本与 manifest 一致', () => {
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
});

test('发版守卫：MAINTENANCE.md 的 patch-version 与 manifest 一致', () => {
  assert.equal(maintenanceField('patch-version'), manifest.version);
});

test('发版守卫：说明书顶条同时对应 skill 与 patch 版本', () => {
  assert.equal(topUpdateEntry(), maintenanceField('skill-version'));
  assert.equal(topPatchEntry(), maintenanceField('patch-version'));
});

test('发版守卫：面板独立升级时顶部条目仍包含面板变更说明', () => {
  const topEntry = maintenance.split(/^## /m)[1] || '';
  assert.ok(topEntry.includes(`配套面板 ${manifest.version}`));
});

test('发版守卫：CHANGELOG 顶部条目版本与 manifest 一致', () => {
  assert.equal(topChangelogVersion(), `v${manifest.version}`);
});

test('发版守卫：下载地址属于本仓库官方 Release', () => {
  assert.ok(isOfficialReleaseDownload(maintenanceField('skill-download')));
  assert.ok(isOfficialReleaseDownload(maintenanceField('patch-download')));
});

test('发版守卫：下载地址拒绝路径穿越、编码路径与非官方来源', () => {
  for (const value of [
    'https://github.com/bfjnbvf/kimi-code-monitor/releases/download/../../archive/refs/heads/main.zip',
    'https://github.com/bfjnbvf/kimi-code-monitor/releases/download/v3.6.0/%2e%2e%2fmain.zip',
    'https://github.com/bfjnbvf/kimi-code-monitor/releases/download/v3.6.0/a%2fb.zip',
    'https://example.com/bfjnbvf/kimi-code-monitor/releases/download/v3.6.0/skill.zip',
  ]) assert.equal(isOfficialReleaseDownload(value), false, value);
});

test('发版守卫：过渡期旧说明书与主说明书一致', () => {
  assert.equal(legacyMaintenance, maintenance);
});
