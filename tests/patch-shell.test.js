// 「点火器」壳测试（macOS / Linux）：install.sh 自己不含安装逻辑，
// 只负责找到运行时跑 install.mjs。这里验证三种分支在真实子进程里都通：
//   ① 系统 node 分支
//   ② 客户端自带 Node 分支（ELECTRON_RUN_AS_NODE——借发动机；Windows 侧的
//      同款验证在 tests/windows-install.js 与 CI 的 windows job）
//   ③ 双缺 → 明确提示、非零退出
// Windows 上 bash 不保证存在，整文件跳过（那条路径由 install.cmd 覆盖）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeInstallStage, makeFakeApp, ROOT } from './helpers/make-install-stage.cjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_SH = path.join(ROOT, 'src', 'panel-app', 'patch', 'install.sh');

/** 无 Node 的最小环境：/usr/bin:/bin 在 macOS 与 ubuntu 都不含 node。 */
const NO_NODE_ENV = {
  HOME: os.homedir(),
  PATH: '/usr/bin:/bin'
};

function runShell(stage, args, { env = {}, withNode = true } = {}) {
  const base = withNode ? process.env : NO_NODE_ENV;
  return execFileSync('bash', [path.join(stage, 'install.sh'), ...args], {
    env: { ...base, ...env },
    encoding: 'utf8'
  });
}

/** 借 Node 分支的运行时可执行文件：CI 注入 electron，本机用真客户端。 */
function findRuntimeExe() {
  if (process.env.KCM_TEST_RUNTIME_EXE) return process.env.KCM_TEST_RUNTIME_EXE;
  const candidates = [
    '/Applications/Kimi Code.app/Contents/MacOS/Kimi Code',
    path.join(os.homedir(), 'Applications/Kimi Code.app/Contents/MacOS/Kimi Code')
  ];
  return candidates.find((p) => fs.existsSync(p)) || '';
}

test('壳：默认环境——安装全流程成功（本机走客户端 Node，CI 无客户端走系统 node）', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kcm-shell-'));
  const stage = makeInstallStage();
  try {
    const { appRoot, dist } = makeFakeApp(path.join(work, 'app'));
    runShell(stage, ['--app', appRoot], { env: { KIMI_CODE_HOME: work } });
    const installed = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
    assert.match(installed, /<script src="\/kcm\/loader\.js\?v=[a-f0-9]{8}"><\/script>/);
    assert.ok(fs.existsSync(path.join(dist, 'kcm', 'loader.js')), '载荷应已同步');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(stage, { recursive: true, force: true });
  }
});

test('壳：客户端自带 Node 分支（ELECTRON_RUN_AS_NODE）——无系统 node 也能装', (t) => {
  const runtimeExe = findRuntimeExe();
  if (!runtimeExe) {
    t.skip('本机没有 Kimi Code 客户端，也未注入 KCM_TEST_RUNTIME_EXE');
    return;
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kcm-shell-'));
  const stage = makeInstallStage();
  try {
    const { appRoot, dist } = makeFakeApp(path.join(work, 'app'));
    // PATH 里没有 node：全程只可能靠 KCM_RUNTIME_EXE 借来的 Node
    runShell(stage, ['--app', appRoot], {
      withNode: false,
      env: { KIMI_CODE_HOME: work, KCM_RUNTIME_EXE: runtimeExe }
    });
    const installed = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
    assert.match(installed, /<script src="\/kcm\/loader\.js\?v=[a-f0-9]{8}"><\/script>/);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(stage, { recursive: true, force: true });
  }
});

test('壳：双缺（无客户端、无 node）——明确提示且非零退出', (t) => {
  if (findRuntimeExe()) t.skip('本机有客户端，造不出「双缺」环境');
  const stage = makeInstallStage();
  try {
    assert.throws(
      () => runShell(stage, [], { withNode: false, env: { KCM_RUNTIME_EXE: '' } }),
      (error) => error.status === 1 && /未找到 Kimi Code 客户端/.test(String(error.stderr))
    );
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
});

test('壳：卸载走同一入口——index.html 逐字节还原', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kcm-shell-'));
  const stage = makeInstallStage();
  try {
    const { appRoot, dist, original } = makeFakeApp(path.join(work, 'app'));
    runShell(stage, ['--app', appRoot], { env: { KIMI_CODE_HOME: work } });
    runShell(stage, ['--app', appRoot, '--uninstall'], { env: { KIMI_CODE_HOME: work } });
    assert.equal(fs.readFileSync(path.join(dist, 'index.html'), 'utf8'), original);
    assert.ok(!fs.existsSync(path.join(dist, 'kcm')), '载荷目录应已删除');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(stage, { recursive: true, force: true });
  }
});
