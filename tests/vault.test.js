import test from 'node:test';
import assert from 'node:assert/strict';
import { createIndexedDBMock } from './background-test-helper.js';

test('首次并发加密共用同一个密钥，所有密文都能解密', async () => {
  globalThis.indexedDB = createIndexedDBMock();
  const vault = await import(`../src/background/vault.js?concurrent=${Date.now()}`);
  const [first, second] = await Promise.all([
    vault.encryptSecret('token-A'),
    vault.encryptSecret('token-B')
  ]);
  assert.equal(await vault.decryptSecret(first), 'token-A');
  assert.equal(await vault.decryptSecret(second), 'token-B');
});
