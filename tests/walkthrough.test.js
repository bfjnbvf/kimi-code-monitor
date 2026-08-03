const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'walkthrough.js'), 'utf8');

test('新手引导公开 stop，并复用 cleanup 清除全局监听', () => {
  assert.match(source, /function cleanup\(\)[\s\S]*?document\.removeEventListener\('keydown'/);
  assert.match(source, /window\.removeEventListener\('resize', layout\)/);
  assert.match(source, /window\.KsbWalkthrough = \{ start, stop: cleanup \};/);
});
