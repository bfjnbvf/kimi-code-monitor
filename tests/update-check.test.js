import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  compareVersions,
  decideUpdate,
  isOfficialReleaseDownload,
  parseMaintenance,
} from '../skill/scripts/check-update.mjs';
import {
  appRootCandidates,
  distDirOf,
  findClientApp,
  readPanelVersion,
} from '../skill/scripts/lib/client-app.mjs';

const installed = (version) => ({ status: 'installed', version });

test('版本比较按数字分段而不是浮点数', () => {
  assert.equal(compareVersions('13.10', '13.2'), 1);
  assert.equal(compareVersions('3.7.0', '3.7'), 0);
  assert.equal(compareVersions('3.7.1', '3.7.2'), -1);
  assert.throws(() => compareVersions('3.7.x', '3.7.2'), /无效版本号/);
});

test('回归：技能和实际面板都与远端相同，不提示更新', () => {
  const result = decideUpdate({
    localSkillVersion: '13.3',
    remoteSkillVersion: '13.3',
    remotePatchVersion: '3.7.2',
    panel: installed('3.7.2'),
  });
  assert.equal(result.skill.status, 'up-to-date');
  assert.equal(result.patch.status, 'up-to-date');
  assert.deepEqual(result.actions, []);
});

test('只有面板旧，动作只包含面板', () => {
  const result = decideUpdate({
    localSkillVersion: '13.3',
    remoteSkillVersion: '13.3',
    remotePatchVersion: '3.7.2',
    panel: installed('3.7.0'),
  });
  assert.deepEqual(result.actions, ['patch']);
});

test('只有技能旧，动作只包含技能', () => {
  const result = decideUpdate({
    localSkillVersion: '13.2',
    remoteSkillVersion: '13.3',
    remotePatchVersion: '3.7.2',
    panel: installed('3.7.2'),
  });
  assert.deepEqual(result.actions, ['skill']);
});

test('两者都旧时分别更新，顺序稳定', () => {
  const result = decideUpdate({
    localSkillVersion: '13.2',
    remoteSkillVersion: '13.3',
    remotePatchVersion: '3.7.2',
    panel: installed('3.7.0'),
  });
  assert.deepEqual(result.actions, ['skill', 'patch']);
});

test('本地版本高于远端时不更新、不降级', () => {
  const result = decideUpdate({
    localSkillVersion: '13.4',
    remoteSkillVersion: '13.3',
    remotePatchVersion: '3.7.2',
    panel: installed('3.8.0'),
  });
  assert.equal(result.skill.status, 'ahead');
  assert.equal(result.patch.status, 'ahead');
  assert.deepEqual(result.actions, []);
});

test('面板未安装与版本未知不会被误判为普通升级', () => {
  const base = {
    localSkillVersion: '13.3',
    remoteSkillVersion: '13.3',
    remotePatchVersion: '3.7.2',
  };
  assert.deepEqual(decideUpdate({ ...base, panel: { status: 'not-installed', version: '' } }).actions, ['install']);
  assert.deepEqual(decideUpdate({ ...base, panel: { status: 'unknown', version: '' } }).actions, ['doctor']);
});

test('下载地址只接受官方 Release 的单段标签和文件名', () => {
  assert.equal(isOfficialReleaseDownload('https://github.com/bfjnbvf/kimi-code-monitor/releases/download/v3.7.2/kimi-code-monitor-desktop-v3.7.2.zip'), true);
  for (const value of [
    'https://github.com/bfjnbvf/kimi-code-monitor/releases/download/../../archive/refs/heads/main.zip',
    'https://github.com/bfjnbvf/kimi-code-monitor/releases/download/v3.7.2/%2e%2e%2fmain.zip',
    'https://github.com/bfjnbvf/kimi-code-monitor/releases/download/v3.7.2/a%2fb.zip',
    'https://example.com/bfjnbvf/kimi-code-monitor/releases/download/v3.7.2/patch.zip',
    'https://github.com/bfjnbvf/kimi-code-monitor/releases/download/v3.7.2/patch.zip?source=other',
  ]) assert.equal(isOfficialReleaseDownload(value), false, value);
});

test('远端说明书必须包含有效版本和官方下载地址', () => {
  const valid = [
    'skill-version: 13.3',
    'patch-version: 3.7.2',
    'skill-download: https://github.com/bfjnbvf/kimi-code-monitor/releases/download/v3.7.2/skill.zip',
    'patch-download: https://github.com/bfjnbvf/kimi-code-monitor/releases/download/v3.7.2/patch.zip',
  ].join('\n');
  assert.equal(parseMaintenance(valid).patchVersion, '3.7.2');
  assert.throws(() => parseMaintenance(valid.replace('skill-version: 13.3', '')), /缺少字段/);
  assert.throws(() => parseMaintenance(valid.replace('github.com', 'example.com')), /下载地址/);
});

test('macOS 应用目录、用户目录和 desktop-dist 直传使用同一推导', () => {
  assert.equal(
    distDirOf('/Applications/Kimi Code.app', 'darwin'),
    '/Applications/Kimi Code.app/Contents/Resources/desktop-dist',
  );
  assert.equal(distDirOf('/tmp/desktop-dist', 'darwin'), '/tmp/desktop-dist');
  assert.deepEqual(appRootCandidates({ platform: 'darwin', env: {}, home: '/Users/test' }), [
    '/Applications/Kimi Code.app',
    '/Users/test/Applications/Kimi Code.app',
  ]);
});

test('Windows 候选路径包含用户、系统和自定义目录', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' };
  assert.deepEqual(appRootCandidates({ platform: 'win32', env }), [
    'C:\\Users\\test\\AppData\\Local\\Programs\\Kimi Code',
    'C:\\Program Files\\Kimi Code',
    'D:\\kimi_code\\Kimi Code',
  ]);
  assert.equal(
    distDirOf('D:\\custom\\Kimi Code', 'win32'),
    'D:\\custom\\Kimi Code\\resources\\desktop-dist',
  );
  assert.equal(distDirOf('D:\\custom\\desktop-dist', 'win32'), 'D:\\custom\\desktop-dist');
});

test('客户端定位支持显式路径并读取真实面板版本', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcm-update-check-'));
  try {
    const app = path.join(root, 'Kimi Code.app');
    const dist = distDirOf(app, 'darwin');
    fs.mkdirSync(path.join(dist, 'kcm'), { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<html></html>');
    fs.writeFileSync(path.join(dist, 'kcm', 'VERSION'), '3.7.2\n');
    assert.equal(findClientApp({ app, platform: 'darwin' }), app);
    assert.deepEqual(readPanelVersion(app, { platform: 'darwin' }), {
      status: 'installed', version: '3.7.2', distDir: dist,
    });
    fs.rmSync(path.join(dist, 'kcm', 'VERSION'));
    assert.equal(readPanelVersion(app, { platform: 'darwin' }).status, 'unknown');
    fs.rmSync(path.join(dist, 'kcm'), { recursive: true });
    assert.equal(readPanelVersion(app, { platform: 'darwin' }).status, 'not-installed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Windows 定位可识别自定义目录，读取失败返回未知', () => {
  const app = 'D:\\custom\\Kimi Code';
  const dist = distDirOf(app, 'win32');
  const index = path.win32.join(dist, 'index.html');
  assert.equal(findClientApp({ app, platform: 'win32', existsSync: (file) => file === index }), app);

  const versionFile = path.win32.join(dist, 'kcm', 'VERSION');
  const fsImpl = {
    existsSync: (file) => file === path.win32.join(dist, 'kcm') || file === versionFile,
    readFileSync: () => { throw new Error('EACCES'); },
  };
  assert.deepEqual(readPanelVersion(app, { platform: 'win32', fsImpl }), {
    status: 'unknown', version: '', distDir: dist, reason: 'unreadable-version',
  });
});
