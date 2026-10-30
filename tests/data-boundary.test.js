import test from 'node:test';
import assert from 'node:assert/strict';
import { allowSensitiveLocalData } from '../src/content/data-boundary.js';

test('只有本机默认 HTTP 端口可以读取本地敏感模块', () => {
  for (const [protocol, hostname, port, expected] of [
    ['http:', '127.0.0.1', '58627', true],
    ['http:', 'localhost', '58627', true],
    ['http:', '127.0.0.1', '12345', false],
    ['https:', '127.0.0.1', '58627', false],
    ['https:', 'code-rc.kimi.com', '', false],
    ['http:', 'example.com', '58627', false]
  ]) {
    globalThis.location = { protocol, hostname, port };
    assert.equal(allowSensitiveLocalData(), expected);
  }
});
