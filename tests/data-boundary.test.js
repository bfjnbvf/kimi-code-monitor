import test from 'node:test';
import assert from 'node:assert/strict';
import { allowSensitiveLocalData } from '../src/content/data-boundary.js';

test('只有本机默认页面可以读取本地敏感模块', () => {
  for (const [hostname, port, expected] of [
    ['127.0.0.1', '58627', true],
    ['localhost', '58627', true],
    ['127.0.0.1', '12345', true],
    ['code-rc.kimi.com', '', false],
    ['example.com', '58627', false]
  ]) {
    globalThis.location = { hostname, port };
    assert.equal(allowSensitiveLocalData(), expected);
  }
});
