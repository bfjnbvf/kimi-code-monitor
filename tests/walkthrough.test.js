import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'walkthrough.js'), 'utf8');

test('新手引导公开 stop，并复用 cleanup 清除全局监听', () => {
  assert.match(source, /function cleanup\(\)[\s\S]*?document\.removeEventListener\('keydown'/);
  assert.match(source, /window\.removeEventListener\('resize', layout\)/);
  assert.match(source, /export \{ start, cleanup as stop \};/);
  assert.doesNotMatch(source, /globalThis\.KsbWalkthrough/);
});
