// Windows 专用 E2E：install.cmd 点火器的两条分支 + 卸载。
//   ① 系统 node 分支（windows-latest 自带 node）
//   ② 借客户端 Node 的分支——CI 里 npm install electron 后用它的 exe 作为
//      KCM_RUNTIME_EXE，真实验证 ELECTRON_RUN_AS_NODE 在 Windows 上可用
//      （这是「零依赖安装」方案唯一无法在 macOS 上验证的前提）
// 在 macOS / Linux 上直接退出 0（对应路径由 tests/patch-shell.test.js 覆盖）。
//
// 用法：node tests/windows-install.cjs   （CI 的 windows job 里运行）
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { makeInstallStage, makeFakeApp } = require('./helpers/make-install-stage.cjs');

if (process.platform !== 'win32') {
  console.log('skip: 仅 Windows 运行（macOS/Linux 的壳测试见 tests/patch-shell.test.js）');
  process.exit(0);
}

const assert = require('node:assert/strict');
const INSTALL_CMD = (stage) => path.join(stage, 'install.cmd');

function runCmd(stage, args, env = {}) {
  return execFileSync(INSTALL_CMD(stage), args, {
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function assertInstalled(dist) {
  const installed = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  assert.match(installed, /<script src="\/kcm\/loader\.js\?v=[a-f0-9]{8}"><\/script>/);
  assert.ok(fs.existsSync(path.join(dist, 'kcm', 'loader.js')), '载荷应已同步');
}

// electron 的 exe 路径（CI 已 npm install electron --no-save；缺失则跳过分支②）
function electronExe() {
  try {
    const p = execFileSync(process.execPath, ['-p', "require('electron')"], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8'
    }).trim();
    return p && fs.existsSync(p) ? p : '';
  } catch {
    return '';
  }
}

let stage;
const failures = [];
function step(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL  ${name}\n      ${error?.message || error}`);
  }
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kcm-win-'));
try {
  stage = makeInstallStage();

  const app1 = path.join(work, 'app-node');
  const { appRoot: root1, dist: dist1, original } = makeFakeApp(app1);
  step('① 系统 node 分支：安装 → 注入 → 幂等 → 卸载还原', () => {
    runCmd(stage, ['--app', root1], { KIMI_CODE_HOME: work });
    assertInstalled(dist1);
    runCmd(stage, ['--app', root1], { KIMI_CODE_HOME: work }); // 幂等重装
    assertInstalled(dist1);
    runCmd(stage, ['--app', root1, '--uninstall'], { KIMI_CODE_HOME: work });
    assert.equal(fs.readFileSync(path.join(dist1, 'index.html'), 'utf8'), original);
    assert.ok(!fs.existsSync(path.join(dist1, 'kcm')), '载荷目录应已删除');
  });

  const exe = electronExe();
  if (!exe) {
    console.log('SKIP  ② 借客户端 Node 分支（未安装 electron，无法验证 RunAsNode）');
  } else {
    const app2 = path.join(work, 'app-runtime');
    const { appRoot: root2, dist: dist2 } = makeFakeApp(app2);
    step('② 借客户端 Node 分支（ELECTRON_RUN_AS_NODE）：无系统 node 参与', () => {
      runCmd(stage, ['--app', root2], {
        KIMI_CODE_HOME: work,
        KCM_RUNTIME_EXE: exe
      });
      assertInstalled(dist2);
      runCmd(stage, ['--app', root2, '--uninstall'], {
        KIMI_CODE_HOME: work,
        KCM_RUNTIME_EXE: exe
      });
    });
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
  if (stage) fs.rmSync(stage, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} 项失败`);
  process.exit(1);
}
console.log('\nWindows 安装链路全部通过');
