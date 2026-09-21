// scan.mjs 测试：wire.jsonl 全量扫描 → usage-daily.js 生成，
// 口径与扩展的 cli-usage.js 完全一致（同一份 parseUsageLines/剪枝函数）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { scanSessions, listWireFiles, renderUsageDailyJs } from '../src/panel-app/patch/scan.mjs';
import { usageDayKey, usageHourKey } from '../src/metrics.js';

function ts(daysAgo, hour, minute = 30) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

function usageLine(time, { inputOther = 0, inputCacheRead = 0, inputCacheCreation = 0, output = 0 }) {
  return JSON.stringify({
    type: 'usage.record',
    usage: { inputOther, inputCacheRead, inputCacheCreation, output },
    time
  });
}

function makeFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kcm-scan-'));
  const sessions = path.join(home, 'sessions');
  const main = path.join(sessions, 'wd_test', 'session_abc', 'agents', 'main');
  const sub = path.join(sessions, 'wd_test', 'session_abc', 'agents', 'agent-1');
  // 不以 session_ 开头的目录：即使有 wire.jsonl 也不计入
  const idle = path.join(sessions, 'wd_test', 'not_a_session', 'agents', 'main');
  fs.mkdirSync(main, { recursive: true });
  fs.mkdirSync(sub, { recursive: true });
  fs.mkdirSync(idle, { recursive: true });
  fs.writeFileSync(path.join(main, 'wire.jsonl'), [
    '{"type":"metadata","protocol_version":"1.5"}',
    usageLine(ts(0, 9), { inputOther: 1000, inputCacheRead: 200, inputCacheCreation: 50, output: 100 }),
    usageLine(ts(0, 10), { inputOther: 100, output: 10 }),
    usageLine(ts(1, 20), { inputOther: 500, inputCacheRead: 100, output: 50 }),
    // 超出 90 天保留期：计入解析但最终被剪枝
    usageLine(ts(95, 12), { inputOther: 999999, output: 1 }),
    '{"type":"turn.ended"}'
  ].join('\n'));
  fs.writeFileSync(path.join(sub, 'wire.jsonl'), usageLine(ts(0, 11), { inputOther: 300, inputCacheRead: 100, output: 30 }) + '\n');
  fs.writeFileSync(path.join(idle, 'wire.jsonl'), usageLine(ts(0, 9), { inputOther: 7777, output: 7 }) + '\n');
  fs.writeFileSync(path.join(home, 'config.toml'), '[secondary_model]\nmodel = "TestSecondary"\n');
  return home;
}

test('scan：按天聚合主/子代理桶，剪掉超期天数，忽略非会话目录', () => {
  const home = makeFixture();
  try {
    const todayKey = usageDayKey(new Date());
    const yesterdayKey = usageDayKey(new Date(Date.now() - 86400e3));
    const result = scanSessions(path.join(home, 'sessions'));

    assert.equal(result.fileCount, 2, '只应计入 session_* 目录下的 wire.jsonl');
    assert.equal(result.secondaryModel, 'TestSecondary', 'config.toml 的 secondary_model 应解析');

    assert.deepEqual(result.daily[todayKey], {
      input: 1750, output: 140, cacheRead: 300,
      sub: { input: 400, output: 30, cacheRead: 100 }
    }, '今日主+子聚合（input 含缓存读/建）');
    assert.deepEqual(result.daily[yesterdayKey], { input: 600, output: 50, cacheRead: 100 }, '昨日只有主代理');
    const keys = Object.keys(result.daily);
    assert.equal(keys.length, 2, '95 天前的记录应被 90 天剪枝');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('scan：按小时聚合（本地小时键 + sub 子桶）', () => {
  const home = makeFixture();
  try {
    const result = scanSessions(path.join(home, 'sessions'));
    const t = ts(0, 11);
    const key = usageHourKey(new Date(t));
    assert.deepEqual(result.hourly[key], {
      input: 400, output: 30, cacheRead: 100,
      sub: { input: 400, output: 30, cacheRead: 100 }
    }, '11 点档只有子代理记录，总桶与子桶同额');
    assert.ok(!result.hourly[usageHourKey(new Date(ts(0, 8)))], '无记录的小时不生成键');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('scan：renderUsageDailyJs 产出可直接执行的赋值脚本', () => {
  const home = makeFixture();
  try {
    const result = scanSessions(path.join(home, 'sessions'));
    const js = renderUsageDailyJs(result);
    assert.ok(js.startsWith('window.__kcmUsageDaily = '), '应为全局赋值脚本');
    const fakeWindow = {};
    new Function('window', js)(fakeWindow);
    const payload = fakeWindow.__kcmUsageDaily;
    assert.ok(payload && typeof payload === 'object');
    assert.equal(payload.secondaryModel, 'TestSecondary');
    assert.ok(payload.daily && payload.hourly, 'daily/hourly 应透传');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('scan：sessions 目录不存在时返回空结果而非报错', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kcm-empty-'));
  try {
    const result = scanSessions(path.join(home, 'nope'));
    assert.equal(result.fileCount, 0);
    assert.deepEqual(result.daily, {});
    assert.equal(result.secondaryModel, '');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('scan：经符号链接路径执行 CLI 正常产出（/tmp → /private/tmp 场景）', () => {
  const home = makeFixture();
  const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcm-link-'));
  try {
    // 仓库里的 scan.mjs 源文件（CLI 判断与打包产物同一段）
    const scriptPath = new URL('../src/panel-app/patch/scan.mjs', import.meta.url).pathname;
    const link = path.join(linkDir, 'scan.mjs');
    fs.symlinkSync(scriptPath, link);
    const out = execFileSync(
      process.execPath,
      [link, '--sessions', path.join(home, 'sessions'), '--stdout'],
      { encoding: 'utf8' }
    );
    assert.ok(
      out.startsWith('window.__kcmUsageDaily = '),
      '符号链接路径下 CLI 应正常输出（曾因 argv 与 import.meta.url 不对齐而静默不执行）'
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(linkDir, { recursive: true, force: true });
  }
});
