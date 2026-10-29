import fs from 'node:fs';
import path from 'node:path';

const PAYLOAD_DIR = 'kcm';

function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirSync(from, to);
    else fs.copyFileSync(from, to);
  }
}

export function syncPayload(dist, renameSync = fs.renameSync, sourceDir) {
  const staged = path.join(dist, `${PAYLOAD_DIR}.new-${process.pid}`);
  const previous = path.join(dist, `${PAYLOAD_DIR}.old-${process.pid}`);
  const payload = path.join(dist, PAYLOAD_DIR);
  fs.rmSync(staged, { recursive: true, force: true });
  fs.rmSync(previous, { recursive: true, force: true });
  let hadPrevious = false;
  try {
    copyDirSync(path.join(sourceDir, PAYLOAD_DIR), staged);
    for (const tool of ['fetch-wallet.mjs', 'scan.mjs']) {
      const source = path.join(sourceDir, tool);
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(staged, tool));
    }
    if (fs.existsSync(payload)) {
      renameSync(payload, previous);
      hadPrevious = true;
    }
    renameSync(staged, payload);
  } catch (error) {
    fs.rmSync(staged, { recursive: true, force: true });
    try {
      if (hadPrevious && !fs.existsSync(payload)) renameSync(previous, payload);
    } catch (rollbackError) {
      throw new Error(`${error.message}；旧载荷恢复失败：${rollbackError.message}`);
    }
    throw error;
  }
  return {
    commit() { fs.rmSync(previous, { recursive: true, force: true }); },
    rollback() {
      fs.rmSync(payload, { recursive: true, force: true });
      if (hadPrevious) renameSync(previous, payload);
    }
  };
}
