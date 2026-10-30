import test from 'node:test';
import assert from 'node:assert/strict';

import { createIndexedDBMock } from './background-test-helper.js';

let permission = 'prompt';
const state = {
  connected: true,
  scanning: false,
  lastScannedAt: '2026-10-30T00:00:00.000Z',
  fileCount: 3
};

globalThis.indexedDB = createIndexedDBMock();
globalThis.chrome = {
  permissions: { onRemoved: { addListener() {} } },
  storage: {
    local: {
      async get(key) { return { [key]: state }; },
      async set() {},
      async remove() {}
    }
  }
};

const { getCliUsageStatus } = await import('../src/background/cli-scan.js');

async function seedHandle() {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('kimi-code-monitor');
    request.onupgradeneeded = () => request.result.createObjectStore('file-handles');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    const request = db.transaction('file-handles', 'readwrite')
      .objectStore('file-handles')
      .put({ name: '.kimi-code', queryPermission: async () => permission }, 'kimi-cli-sessions');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  db.close();
}

await seedHandle();

test('CLI 权限 prompt 时保留已连接数据展示，但禁止自动刷新', async () => {
  const status = await getCliUsageStatus();
  assert.equal(status.permission, 'prompt');
  assert.equal(status.connected, true);
  assert.equal(status.canRefresh, false);
  assert.equal(status.fileCount, 3);
});

test('CLI 权限 granted 时允许刷新，denied 时才断开展示', async () => {
  permission = 'granted';
  let status = await getCliUsageStatus();
  assert.equal(status.connected, true);
  assert.equal(status.canRefresh, true);

  permission = 'denied';
  status = await getCliUsageStatus();
  assert.equal(status.connected, false);
  assert.equal(status.canRefresh, false);
});
