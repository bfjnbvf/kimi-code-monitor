// 发版纪律守卫：版本号三处一致 + CHANGELOG 顶部条目对应当前版本。
// 漏改任何一处，npm test 直接失败（发版流程见 docs/HANDOFF.md §七）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const maintenance = fs.readFileSync(path.join(ROOT, 'skill', 'MAINTENANCE'), 'utf8');
const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');

const maintenanceField = (name) => {
  const m = maintenance.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'));
  assert.ok(m, `skill/MAINTENANCE 缺少 ${name} 字段`);
  return m[1].trim();
};

const topUpdateEntry = () => {
  const m = maintenance.match(/^## (\d+)（/m);
  assert.ok(m, 'skill/MAINTENANCE 缺少更新记录条目（## N（date））');
  return Number(m[1]);
};

const topChangelogVersion = () => {
  const m = changelog.match(/^## (v[\d.]+)/m);
  assert.ok(m, 'CHANGELOG.md 缺少版本条目（## vX.Y.Z（date））');
  return m[1];
};

test('发版守卫：manifest 与 package.json 版本一致', () => {
  assert.equal(
    manifest.version,
    pkg.version,
    `manifest.json（${manifest.version}）与 package.json（${pkg.version}）版本不一致`
  );
});

test('发版守卫：MAINTENANCE 的 patch-version 与 manifest 一致', () => {
  assert.equal(
    maintenanceField('patch-version'),
    manifest.version,
    `skill/MAINTENANCE 的 patch-version 与 manifest.json（${manifest.version}）不一致`
  );
});

test('发版守卫：MAINTENANCE 更新记录顶条编号与 skill-version 一致', () => {
  assert.equal(
    topUpdateEntry(),
    Number(maintenanceField('skill-version')),
    'MAINTENANCE 更新记录顶条编号与 skill-version 不一致（有文档变更就要 bump 并加条目）'
  );
});

test('发版守卫：CHANGELOG 顶部条目版本与 manifest 一致', () => {
  assert.equal(
    topChangelogVersion(),
    `v${manifest.version}`,
    `CHANGELOG.md 顶部条目（${topChangelogVersion()}）与 manifest.json（v${manifest.version}）不一致`
  );
});
