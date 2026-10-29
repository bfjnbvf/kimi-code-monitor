import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function buildHud() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const options = { bundle: true, platform: 'node', format: 'cjs', target: 'node20', minify: true, logLevel: 'info' };
  await Promise.all([
    build({ ...options, stdin: { contents: "import { main } from './src/cli-hud/hud.mjs'; try { main(); } catch { process.exitCode = 1; }", resolveDir: root },
      outfile: path.join(root, 'dist/hud.cjs') }),
    build({ ...options, stdin: { contents: "import { quotaMain } from './src/cli-hud/quota-worker.mjs'; void quotaMain();", resolveDir: root },
      outfile: path.join(root, 'dist/quota-worker.cjs') }),
  ]);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await buildHud();
