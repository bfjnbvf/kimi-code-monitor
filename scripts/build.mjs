// 构建脚本：把 src/ 的 ES modules 打成四个 iife bundle（content / background / popup / panel-app）。
// 产物布局与原散装脚本一致，manifest/popup.html 只引用 dist/ 下的文件。
// 路径一律从本文件位置推导（脚本在 scripts/，仓库根是它的上一级），
// 这样从任何工作目录调用都落在同一个 dist/。
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const shared = {
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  sourcemap: false,
  logLevel: 'info'
};

const entries = [
  ['src/content.js', 'dist/content.js'],
  ['src/background.js', 'dist/background.js'],
  ['src/popup.js', 'dist/popup.js'],
  ['src/panel-app.js', 'dist/panel-app.js']
];

for (const [entryPoint, outfile] of entries) {
  await build({
    ...shared,
    entryPoints: [path.join(ROOT, entryPoint)],
    outfile: path.join(ROOT, outfile)
  });
}
