// 补丁安装器（install.mjs）与自检（doctor.mjs）测试：
// 平台差异纯函数双平台注入、载荷哈希与旧 bash 管线黄金值对齐、
// 装/卸/幂等全流程在临时假客户端目录上真跑子进程。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  appRootCandidates,
  distDirOf,
  payloadHash,
  stripLoaderTagLines,
  injectLoaderTag
} from '../src/panel-app/patch/install.mjs';
import { payloadHash as doctorPayloadHash } from '../skill/scripts/doctor.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const INSTALL_MJS = path.join(ROOT, 'src/panel-app/patch/install.mjs');
const SCAN_MJS = path.join(ROOT, 'src/panel-app/patch/scan.mjs');

/* ---------- 平台差异纯函数（双平台注入，不碰文件系统） ---------- */

test('appRootCandidates：macOS 默认候选 + KIMI_CODE_APP_DIR 优先', () => {
  const mac = appRootCandidates({}, '/Users/tester', 'darwin');
  assert.deepEqual(mac, ['/Applications/Kimi Code.app', '/Users/tester/Applications/Kimi Code.app']);
  const withEnv = appRootCandidates({ KIMI_CODE_APP_DIR: '/opt/kimi' }, '/Users/tester', 'darwin');
  assert.equal(withEnv[0], '/opt/kimi');
});

test('appRootCandidates：Windows 候选含 LOCALAPPDATA 与 Program Files', () => {
  const win = appRootCandidates({ LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' }, 'C:\\Users\\tester', 'win32');
  assert.deepEqual(win, [
    'C:\\Users\\tester\\AppData\\Local\\Programs\\Kimi Code',
    'C:\\Program Files\\Kimi Code',
    'D:\\kimi_code\\Kimi Code'
  ]);
  const withEnv = appRootCandidates({ KIMI_CODE_APP_DIR: 'E:\\kimi', LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' }, 'C:\\Users\\tester', 'win32');
  assert.equal(withEnv[0], 'E:\\kimi');
});

test('distDirOf：两平台推导 + desktop-dist 直通', () => {
  assert.equal(
    distDirOf('/Applications/Kimi Code.app', 'darwin'),
    '/Applications/Kimi Code.app/Contents/Resources/desktop-dist'
  );
  assert.equal(
    distDirOf('C:\\Users\\tester\\AppData\\Local\\Programs\\Kimi Code', 'win32'),
    'C:\\Users\\tester\\AppData\\Local\\Programs\\Kimi Code\\resources\\desktop-dist'
  );
  assert.equal(distDirOf('/any/where/desktop-dist', 'darwin'), '/any/where/desktop-dist');
  assert.equal(distDirOf('D:\\kimi\\desktop-dist', 'win32'), 'D:\\kimi\\desktop-dist');
});

/* ---------- 标签操作 ---------- */

test('stripLoaderTagLines：移除注入行且幂等', () => {
  const html = '<html>\n<head>      <script src="/kcm/loader.js?v=abc12345"></script>\n</head>\n<body></body>\n</html>';
  const stripped = stripLoaderTagLines(html);
  assert.ok(!stripped.includes('kcm/loader.js'));
  assert.equal(stripLoaderTagLines(stripped), stripped);
});

test('injectLoaderTag：插入首个 </head> 前；缺失返回 null', () => {
  const html = '<html><head><title>t</title></head><body></body></html>';
  const out = injectLoaderTag(html, 'deadbeef');
  assert.equal(out, '<html><head><title>t</title>      <script src="/kcm/loader.js?v=deadbeef"></script>\n</head><body></body></html>');
  assert.equal(injectLoaderTag('<html><body></body></html>', 'x'), null);
});

/* ---------- 载荷哈希：与旧 bash 管线（find|shasum|sort|shasum）逐字节兼容 ---------- */

function makeHashFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcm-hash-'));
  fs.mkdirSync(path.join(root, 'kcm', 'rive'), { recursive: true });
  fs.writeFileSync(path.join(root, 'kcm', 'loader.js'), '// loader fixture\n');
  fs.writeFileSync(path.join(root, 'kcm', 'content.css'), '/* css fixture */\n');
  fs.writeFileSync(path.join(root, 'kcm', 'rive', 'rive.js'), '// rive fixture\n');
  return path.join(root, 'kcm');
}

test('payloadHash：黄金值对齐旧 bash 管线', () => {
  const vib = makeHashFixture();
  try {
    // 期望值由 macOS 上旧 install.sh 的同款管线产出（2026-09-21）：
    //   find . -type f ! -name usage-daily.js ! -name external.js -exec shasum -a 256 {} \; | sort | shasum -a 256 | cut -c1-8
    assert.equal(payloadHash(vib), 'f6b964f9');
  } finally {
    fs.rmSync(path.dirname(vib), { recursive: true, force: true });
  }
});

test('payloadHash：机器数据与工具文件不参与哈希', () => {
  const vib = makeHashFixture();
  try {
    const before = payloadHash(vib);
    for (const f of ['usage-daily.js', 'external.js', 'wallet.js', 'fetch-wallet.mjs']) {
      fs.writeFileSync(path.join(vib, f), `// ${f} fixture`);
    }
    assert.equal(payloadHash(vib), before);
  } finally {
    fs.rmSync(path.dirname(vib), { recursive: true, force: true });
  }
});

test('payloadHash：安装器与 doctor 两份自包含实现一致', () => {
  const vib = makeHashFixture();
  try {
    assert.equal(payloadHash(vib), doctorPayloadHash(vib));
  } finally {
    fs.rmSync(path.dirname(vib), { recursive: true, force: true });
  }
});

/* ---------- 全流程集成：临时假客户端目录上真跑 install.mjs ---------- */

// 假补丁目录：install.mjs 自包含可直接复制；scan.mjs 复刻发布形态——
// esbuild 打包成零依赖单文件（与 build-patch.mjs 同配置），源码版的
// '../../cli-usage.js' 相对导入离开 src/ 树会失效。
async function makeFakePatchDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcm-patch-'));
  fs.copyFileSync(INSTALL_MJS, path.join(dir, 'install.mjs'));
  await build({
    entryPoints: [SCAN_MJS],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node16',
    logLevel: 'error',
    outfile: path.join(dir, 'scan.mjs')
  });
  fs.mkdirSync(path.join(dir, 'kcm', 'rive'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'kcm', 'loader.js'), '// loader fixture\n');
  fs.writeFileSync(path.join(dir, 'kcm', 'content.css'), '/* css fixture */\n');
  fs.writeFileSync(path.join(dir, 'kcm', 'rive', 'rive.js'), '// rive fixture\n');
  return dir;
}

function makeFakeApp(root) {
  const dist = distDirOf(root);
  fs.mkdirSync(dist, { recursive: true });
  const original = '<!DOCTYPE html>\n<html>\n<head>\n  <title>Kimi Code</title>\n</head>\n<body>\n  <div id="app"></div>\n</body>\n</html>\n';
  fs.writeFileSync(path.join(dist, 'index.html'), original);
  return { dist, original };
}

function makeFakeSessions(root) {
  const wire = path.join(root, 'sessions', 'ws_test', 'session_test', 'agents', 'main');
  fs.mkdirSync(wire, { recursive: true });
  fs.writeFileSync(
    path.join(wire, 'wire.jsonl'),
    `${JSON.stringify({
      type: 'usage.record',
      model: 'kimi-code/test',
      usage: { inputOther: 100, inputCacheRead: 20, inputCacheCreation: 5, output: 10 },
      usageScope: 'turn',
      time: 1785686400000
    })}\n`
  );
  return path.join(root, 'sessions');
}

function runInstaller(patchDir, extraArgs, env) {
  return execFileSync(process.execPath, [path.join(patchDir, 'install.mjs'), ...extraArgs], {
    env: { ...process.env, ...env },
    stdio: 'pipe',
    encoding: 'utf8'
  });
}

test('集成：安装 → 幂等重装 → 卸载全流程（本机平台）', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kcm-flow-'));
  try {
    const patchDir = await makeFakePatchDir();
    const appRoot = path.join(work, 'app');
    const { dist, original } = makeFakeApp(appRoot);
    const sessions = makeFakeSessions(work);
    const env = { KIMI_CODE_HOME: work };

    // 安装（--app 指向假客户端；distDirOf 对本机平台推导）
    runInstaller(patchDir, ['--app', appRoot], env);

    const index = path.join(dist, 'index.html');
    const installed = fs.readFileSync(index, 'utf8');
    assert.ok(fs.existsSync(path.join(dist, 'index.html.bak-kcm')), '应创建原始备份');
    assert.match(installed, /<script src="\/kcm\/loader\.js\?v=[a-f0-9]{8}"><\/script>/);
    assert.ok(installed.includes('<title>Kimi Code</title>'), '原有内容不被破坏');
    assert.ok(fs.existsSync(path.join(dist, 'kcm', 'loader.js')), '载荷应已同步');

    // 标签哈希 = 载荷实际哈希
    const tag = installed.match(/kcm\/loader\.js\?v=([a-f0-9]{8})/)[1];
    assert.equal(tag, payloadHash(path.join(dist, 'kcm')));

    // 历史预填：scan.mjs 应生成 usage-daily.js
    const daily = path.join(dist, 'kcm', 'usage-daily.js');
    assert.ok(fs.existsSync(daily), '应预填 usage-daily.js');
    assert.ok(fs.readFileSync(daily, 'utf8').includes('__kcmUsageDaily'));

    // 幂等：重装后 index.html 逐字节不变
    runInstaller(patchDir, ['--app', appRoot], env);
    assert.equal(fs.readFileSync(index, 'utf8'), installed, '重装不应改动 index.html');

    // 卸载：index.html 还原为原始内容，补丁目录与备份清除
    runInstaller(patchDir, ['--uninstall', '--app', appRoot], env);
    assert.equal(fs.readFileSync(index, 'utf8'), original, '卸载应还原原始 index.html');
    assert.ok(!fs.existsSync(path.join(dist, 'kcm')), '补丁目录应删除');
    assert.ok(!fs.existsSync(path.join(dist, 'index.html.bak-kcm')), '备份应清除');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('集成：无 sessions 目录时跳过预填但安装成功', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kcm-noscan-'));
  try {
    const patchDir = await makeFakePatchDir();
    const appRoot = path.join(work, 'app');
    const { dist } = makeFakeApp(appRoot);
    const env = { KIMI_CODE_HOME: path.join(work, 'empty-home') };

    runInstaller(patchDir, ['--app', appRoot], env);
    assert.ok(fs.existsSync(path.join(dist, 'kcm', 'loader.js')));
    assert.ok(!fs.existsSync(path.join(dist, 'kcm', 'usage-daily.js')), '无 sessions 时不应生成 usage-daily.js');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

// 不用「候选全部落空」测发现失败：开发机装着真客户端，无 --app 的探测会
// 指向真实安装目录。用 --app 指向不存在目录测同一失败出口（exit 1）。
test('集成：--app 指向无效目录时非零退出', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kcm-badapp-'));
  try {
    const patchDir = await makeFakePatchDir();
    assert.throws(
      () => runInstaller(patchDir, ['--app', path.join(work, 'nonexistent')], {}),
      (error) => error.status === 1
    );
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

