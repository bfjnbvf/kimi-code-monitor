// 构建脚本：把 src/ 的 ES modules 打成三个 iife bundle（content / background / popup）。
// 产物布局与原散装脚本一致，manifest/popup.html 只引用 dist/ 下的文件。
import { build } from 'esbuild';

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
  ['src/popup.js', 'dist/popup.js']
];

for (const [entryPoints, outfile] of entries) {
  await build({ ...shared, entryPoints: [entryPoints], outfile });
}
