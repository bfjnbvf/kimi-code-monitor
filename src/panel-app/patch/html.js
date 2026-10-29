import fs from 'node:fs';
import path from 'node:path';

const LOADER_SRC = '/kcm/loader.js';

export function stripLoaderTagLines(html) {
  return html.replace(/\s*<script\b[^>]*\bsrc=(["'])\/kcm\/loader\.js(?:\?[^"']*)?\1[^>]*><\/script>/g, '');
}

export function injectLoaderTag(html, hash) {
  const marker = '</head>';
  const idx = html.indexOf(marker);
  if (idx < 0) return null;
  const needsNewline = idx > 0 && html[idx - 1] !== '\n';
  const tag = `      <script src="${LOADER_SRC}?v=${hash}"></script>${needsNewline ? '' : '\n'}`;
  return html.slice(0, idx) + (needsNewline ? '\n' : '') + tag + html.slice(idx);
}

export function replaceIndex(index, content) {
  const staged = path.join(path.dirname(index), `.kcm-index-${process.pid}.html`);
  const mode = fs.existsSync(index) ? fs.statSync(index).mode : 0o600;
  fs.rmSync(staged, { force: true });
  try {
    fs.writeFileSync(staged, content, { mode });
    fs.renameSync(staged, index);
  } catch (error) {
    fs.rmSync(staged, { force: true });
    throw error;
  }
}
