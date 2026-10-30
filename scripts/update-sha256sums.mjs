// 单项打包后同步更新对应校验和，避免重打资产后 SHA256SUMS 仍指向旧 ZIP。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = process.argv.slice(2);
if (!files.length) throw new Error('用法：node scripts/update-sha256sums.mjs <zip> [...]');

const output = path.join(ROOT, 'SHA256SUMS');
const entries = new Map();
if (fs.existsSync(output)) {
  for (const line of fs.readFileSync(output, 'utf8').split('\n')) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (match) entries.set(match[2], match[1]);
  }
}

for (const file of files) {
  const absolute = path.resolve(ROOT, file);
  const relative = path.relative(ROOT, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`校验目标必须位于项目内：${file}`);
  }
  const hash = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
  entries.set(relative, hash);
}

fs.writeFileSync(output, `${[...entries].map(([file, hash]) => `${hash}  ${file}`).join('\n')}\n`);
