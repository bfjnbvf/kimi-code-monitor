// 跨平台组装「发布形态」的补丁 stage：install.mjs / install.sh / install.cmd
// + kcm/ 载荷。壳的测试（tests/patch-shell.test.js）与 Windows CI
// （tests/windows-install.js）共用，保证测的就是打进 zip 的那几个文件。
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const PATCH = path.join(ROOT, 'src', 'panel-app', 'patch');

/** 组装 stage 目录并返回其路径。调用方负责清理。 */
function makeInstallStage() {
  const panelApp = path.join(ROOT, 'dist', 'panel-app.js');
  if (!fs.existsSync(panelApp)) {
    throw new Error('缺 dist/panel-app.js——先跑 npm run build（npm test 会自动做）');
  }
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'kcm-stage-'));
  for (const name of ['install.mjs', 'install.sh', 'install.cmd', 'scan.mjs', 'fetch-wallet.mjs']) {
    fs.copyFileSync(path.join(PATCH, name), path.join(stage, name));
  }
  fs.chmodSync(path.join(stage, 'install.sh'), 0o755);
  fs.mkdirSync(path.join(stage, 'kcm', 'rive'), { recursive: true });
  fs.copyFileSync(path.join(PATCH, 'loader.js'), path.join(stage, 'kcm', 'loader.js'));
  fs.copyFileSync(panelApp, path.join(stage, 'kcm', 'panel-app.js'));
  fs.copyFileSync(path.join(ROOT, 'content.css'), path.join(stage, 'kcm', 'content.css'));
  fs.writeFileSync(path.join(stage, 'kcm', 'VERSION'), 'test\n');
  fs.writeFileSync(path.join(stage, 'kcm', 'rive', 'rive.js'), '// rive fixture\n');
  return stage;
}

/** 造一个假客户端目录（按本机平台结构），返回 { appRoot, dist, original }。 */
function makeFakeApp(root) {
  const isWin = process.platform === 'win32';
  const dist = isWin
    ? path.join(root, 'resources', 'desktop-dist')
    : path.join(root, 'Contents', 'Resources', 'desktop-dist');
  fs.mkdirSync(dist, { recursive: true });
  const original = '<!DOCTYPE html>\n<html>\n<head>\n  <title>Kimi Code</title>\n</head>\n<body>\n  <div id="app"></div>\n</body>\n</html>\n';
  fs.writeFileSync(path.join(dist, 'index.html'), original);
  return { appRoot: root, dist, original };
}

module.exports = { makeInstallStage, makeFakeApp, ROOT };
