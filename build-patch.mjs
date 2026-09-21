// 补丁包构建：产出 kcm-desktop-patch-v<version>.zip
// 内容：install.mjs + install.sh + scan.mjs / fetch-wallet.mjs（零依赖单文件）+ kcm/（loader、panel-app、样式、Rive 资产）
// 与扩展共用 src/ 与 content.css/rive，一次源码改动两侧同时生效。
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STAGE = path.join(ROOT, 'dist-patch');

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(path.join(STAGE, 'kcm'), { recursive: true });

// scan.mjs / fetch-wallet.mjs 打包成零依赖单文件（解析依赖内联）
await build({
  entryPoints: [path.join(ROOT, 'src/panel-app/patch/scan.mjs')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node16',
  sourcemap: false,
  logLevel: 'info',
  outfile: path.join(STAGE, 'scan.mjs')
});

await build({
  entryPoints: [path.join(ROOT, 'src/panel-app/patch/fetch-wallet.mjs')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node16',
  sourcemap: false,
  logLevel: 'info',
  outfile: path.join(STAGE, 'fetch-wallet.mjs')
});

// 面板 bundle（与 build.mjs 的 panel-app 目标同配置）
await build({
  entryPoints: [path.join(ROOT, 'src/panel-app.js')],
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  sourcemap: false,
  logLevel: 'info',
  outfile: path.join(STAGE, 'kcm/panel-app.js')
});

// loader / 安装器 / 样式 / Rive 资产
// 安装器双份：install.mjs（跨平台主推，Node ≥16）+ install.sh（旧版，过渡期保留）
const PATCH = path.join(ROOT, 'src/panel-app/patch');
fs.copyFileSync(path.join(PATCH, 'loader.js'), path.join(STAGE, 'kcm/loader.js'));
fs.copyFileSync(path.join(PATCH, 'install.sh'), path.join(STAGE, 'install.sh'));
fs.chmodSync(path.join(STAGE, 'install.sh'), 0o755);
fs.copyFileSync(path.join(PATCH, 'install.mjs'), path.join(STAGE, 'install.mjs'));
fs.copyFileSync(path.join(ROOT, 'content.css'), path.join(STAGE, 'kcm/content.css'));
fs.cpSync(path.join(ROOT, 'rive'), path.join(STAGE, 'kcm/rive'), { recursive: true });

const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version;
// 补丁版本标记：doctor.mjs 与技能自更新比对用
fs.writeFileSync(path.join(STAGE, 'kcm', 'VERSION'), `${version}\n`);
const out = path.join(ROOT, `kcm-desktop-patch-v${version}.zip`);
fs.rmSync(out, { force: true });
execFileSync('zip', ['-r', '-X', out, 'install.mjs', 'install.sh', 'scan.mjs', 'fetch-wallet.mjs', 'kcm', '-x', '*.DS_Store'], { cwd: STAGE });
console.log(`已生成 kcm-desktop-patch-v${version}.zip`);
