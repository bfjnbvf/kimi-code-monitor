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
  // t.skip 只标记不中断，必须紧跟 return：否则测试体照跑，下面不带 --app 的
  // 壳会定位到本机真实客户端并当场装一遍
  if (findRuntimeExe()) {
    t.skip('本机有客户端，造不出「双缺」环境');
    return;
  }
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

/* ---------- run 壳（技能脚本的统一运行入口） ---------- */

test('run 壳：默认环境跑通脚本（裸脚本名按壳所在目录解析）', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kcm-run-'));
  try {
    let output = '';
    try {
      output = execFileSync('bash', [path.join(ROOT, 'skill/scripts/run.sh'), 'client-providers.mjs', '--port', '1'], {
        cwd: work, encoding: 'utf8'
      });
    } catch (error) {
      // 假端口探测失败属预期：脚本真实执行并以非零码退出——壳的职责已完成
      output = String(error.stdout || '') + String(error.stderr || '');
      assert.equal(error.status, 1);
    }
    assert.match(output, /FAIL|SUMMARY/, '脚本应经壳真实执行（无客户端时也应输出 FAIL 而非壳报错）');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('run 壳：无系统 node 时借客户端 Node 跑通任意脚本', (t) => {
  const runtimeExe = findRuntimeExe();
  if (!runtimeExe) {
    t.skip('本机没有 Kimi Code 客户端，也未注入 KCM_TEST_RUNTIME_EXE');
    return;
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kcm-run-'));
  const probe = path.join(work, 'probe.mjs');
  fs.writeFileSync(probe, 'console.log("RUNTIME_OK", process.version);\n');
  try {
    const out = execFileSync('bash', [path.join(ROOT, 'skill/scripts/run.sh'), probe], {
      cwd: work,
      env: { HOME: os.homedir(), PATH: '/usr/bin:/bin', KCM_RUNTIME_EXE: runtimeExe },
      encoding: 'utf8'
    });
    assert.match(out, /RUNTIME_OK/, '应借客户端 Node 执行目标脚本');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('run 壳：脚本不存在 → 明确报错非零退出', () => {
  assert.throws(
    () => execFileSync('bash', [path.join(ROOT, 'skill/scripts/run.sh'), 'no-such-script.mjs'], { encoding: 'utf8' }),
    (error) => error.status === 1 && /脚本不存在/.test(String(error.stderr))
  );
});
