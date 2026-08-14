import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import * as KimiMetrics from '../src/metrics.js';
import * as KimiCliUsage from '../src/cli-usage.js';
import { loadBackgroundModule, runInBackgroundContext } from './background-test-helper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backgroundSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'background.js'), 'utf8');

test('默认模式不再暴露 WebSocket 长期存档消息，只保留 CLI 长期统计入口', () => {
  assert.doesNotMatch(backgroundSource, /'usage\.record':/);
  assert.doesNotMatch(backgroundSource, /'usage\.turn':/);
  assert.doesNotMatch(backgroundSource, /'session\.usage\.get':/);
  assert.match(backgroundSource, /'cli\.usage\.status': getCliUsageStatus/);
  assert.match(backgroundSource, /'cli\.usage\.refresh': refreshCliUsage/);
});

function eventTarget() {
  return { addListener() {}, removeListener() {} };
}

function storageArea(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      if (keys == null) return { ...data };
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((key) => key in data).map((key) => [key, data[key]]));
    },
    async set(values) {
      Object.assign(data, values);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    }
  };
}

function createIndexedDBMock() {
  const dbs = new Map();
  function request(result) {
    const r = { result, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      if (r.onsuccess) r.onsuccess({ target: r });
    });
    return r;
  }
  function getStore(db, name) {
    if (!db.stores[name]) db.stores[name] = new Map();
    return db.stores[name];
  }
  return {
    open(dbName, version) {
      let db = dbs.get(dbName);
      let upgraded = false;
      if (!db) {
        db = {
          name: dbName,
          version: version || 1,
          stores: {},
          objectStoreNames: {
            names: new Set(),
            contains(name) { return this.names.has(name); },
            [Symbol.iterator]() { return this.names.values(); }
          },
          createObjectStore(name) {
            getStore(db, name);
            this.objectStoreNames.names.add(name);
            return {};
          },
          close() {}
        };
        db.createObjectStore = db.createObjectStore.bind(db);
        db.transaction = (storeName, mode) => {
          const store = getStore(db, storeName);
          return {
            objectStore() {
              return {
                get(key) { return request(store.get(key)); },
                put(value, key) { store.set(key, value); return request(undefined); },
                delete(key) { store.delete(key); return request(undefined); }
              };
            },
            onabort: null
          };
        };
        db.close = () => {};
        dbs.set(dbName, db);
        upgraded = true;
      } else if (version && db.version < version) {
        db.version = version;
        upgraded = true;
      }
      const r = { result: db, onsuccess: null, onerror: null, onupgradeneeded: null };
      queueMicrotask(() => {
        if (upgraded && r.onupgradeneeded) {
          r.onupgradeneeded({ target: r, oldVersion: 0, newVersion: version || 1 });
        }
        if (r.onsuccess) r.onsuccess({ target: r });
      });
      return r;
    },
    transaction(db, storeName, mode) {
      const store = getStore(db, storeName);
      return {
        objectStore() {
          return {
            get(key) { return request(store.get(key)); },
            put(value, key) { store.set(key, value); return request(undefined); },
            delete(key) { store.delete(key); return request(undefined); }
          };
        },
        onabort: null
      };
    }
  };
}

async function loadBackground({ local = {}, fetchImpl = async () => { throw new Error('unexpected fetch'); } } = {}) {
  const localArea = storageArea(local);
  const sessionArea = storageArea();
  const notifications = [];

  Object.assign(globalThis, {
    AbortController,
    AbortSignal,
    TextDecoder,
    TextEncoder,
    URLSearchParams,
    atob,
    btoa,
    clearTimeout,
    console,
    fetch: fetchImpl,
    importScripts() {},
    indexedDB: createIndexedDBMock(),
    KimiCliUsage,
    KimiMetrics,
    setTimeout,
    chrome: {
      alarms: {
        onAlarm: eventTarget(),
        async create() {},
        async clear() { return true; },
        async get() { return null; }
      },
      notifications: {
        onClicked: eventTarget(),
        create(id, options) {
          notifications.push({ id, options });
          return Promise.resolve(id);
        },
        async clear() { return true; }
      },
      runtime: {
        onMessage: eventTarget(),
        getManifest() { return { version: 'test' }; }
      },
      storage: { local: localArea, session: sessionArea },
      tabs: {
        async create() { return { id: 1 }; },
        async query() { return []; },
        async remove() {},
        async sendMessage() {},
        async update() {}
      }
    }
  });

  // Node 的 globalThis.navigator 是只读 getter，需用 defineProperty 覆盖
  Object.defineProperty(globalThis, 'navigator', {
    value: { platform: 'test', userAgent: 'test' },
    configurable: true,
    writable: true,
    enumerable: true
  });

  await loadBackgroundModule();

  const context = vm.createContext(globalThis);
  return {
    context,
    local: localArea.data,
    notifications,
    run(expression) { return runInBackgroundContext(expression, context); }
  };
}

test('额度预警按原始百分比判断，不因四舍五入提前触发', async () => {
  const app = await loadBackground();

  await app.run(`evaluateQuotaAlerts({ usage: { limit: 1000, used: 795 } })`);
  assert.equal(app.notifications.length, 0);

  await app.run(`evaluateQuotaAlerts({ usage: { limit: 1000, used: 800 } })`);
  assert.equal(app.notifications.length, 1);
  assert.equal(app.notifications[0].id, 'quota-week-80');

  await app.run(`evaluateQuotaAlerts({ usage: { limit: 1000, used: 949 } })`);
  assert.equal(app.notifications.length, 1);

  await app.run(`evaluateQuotaAlerts({ usage: { limit: 1000, used: 950 } })`);
  assert.equal(app.notifications.length, 2);
  assert.equal(app.notifications[1].id, 'quota-week-95');
});

test('过期 token 刷新失败时 auth.status 不再误报已授权', async () => {
  const app = await loadBackground({
    local: {
      kimiOAuthToken: {
        access_token: 'expired-access',
        refresh_token: 'expired-refresh',
        expires_at: 1
      }
    },
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      async json() { return { error: 'invalid_grant' }; }
    })
  });

  const status = await app.run('authStatus()');
  assert.equal(status.ok, true);
  assert.equal(status.authorized, false);
});

test('额度响应会等待预警状态与每日快照落盘后再结束', async () => {
  const app = await loadBackground({
    local: {
      kimiOAuthToken: {
        access_token: 'valid-access',
        refresh_token: 'valid-refresh',
        expires_at: Math.floor(Date.now() / 1_000) + 3_600
      }
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() { return { limits: [], usage: { limit: 100, used: 85 } }; }
    })
  });

  const state = await app.run(`fetchQuotaFresh()`);
  assert.equal(state.ok, true);
  // 返回时预警状态与当日快照均已落盘（used 85 越过 80% 档）
  const alertStates = Object.values(app.local.quotaAlertState || {});
  assert.ok(alertStates[0]?.week?.notified80, '预警状态应已写入');
  const todayKey = KimiMetrics.usageDayKey(new Date());
  assert.ok(app.local.quotaSnapshots?.[todayKey], '当日额度快照应已写入');
});

test('resetAndStartOAuth 会等待 pending 的旧授权流程结束后再发起新流程', async () => {
  let deviceAuthCalls = 0;
  let releaseStalledFlow;
  const stalled = new Promise((resolve) => { releaseStalledFlow = resolve; });
  const app = await loadBackground({
    fetchImpl: async (url) => {
      if (String(url).includes('device_authorization')) {
        deviceAuthCalls += 1;
        // 第一次设备授权请求挂起，让旧流程停在 pending
        if (deviceAuthCalls === 1) await stalled;
        const seq = deviceAuthCalls;
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              device_code: `device-${seq}`,
              user_code: `CODE-${seq}`,
              expires_in: 900,
              interval: 5,
              verification_uri_complete: 'https://auth.kimi.com/activate'
            };
          }
        };
      }
      // token 轮询返回致命错误：清场即止，不会留下待执行的轮询定时器
      return { ok: false, status: 400, async json() { return { error: 'expired_token' }; } };
    }
  });

  const oldFlow = app.run('startOAuth()');
  let oldFlowError = null;
  oldFlow.catch((error) => { oldFlowError = error; });

  const resetPromise = app.run('resetAndStartOAuth()');
  // 等 clearAuth 完成（authRevision 已递增）后再放行挂起的旧流程
  await new Promise((resolve) => setTimeout(resolve, 10));
  releaseStalledFlow();
  const result = await resetPromise;

  assert.equal(deviceAuthCalls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.userCode, 'CODE-2');
  assert.equal(oldFlowError?.message, '授权已被取消');
});

test('withStorageLock 同一 key 串行，不同 key 并行', async () => {
  const app = await loadBackground();
  const overlaps = await app.run(`(async () => {
    const overlaps = [];
    const running = new Set();
    async function run(key, name) {
      return withStorageLock(key, async () => {
        overlaps.push([...running]);
        running.add(name);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running.delete(name);
      });
    }
    await Promise.all([run('k1', 'a'), run('k1', 'b'), run('k2', 'c')]);
    return overlaps;
  })()`);
  // a 与 b 共用 key k1，不应同时运行；c 在 k2，可与 a/b 重叠
  assert.ok(!overlaps.some((set) => set.includes('a') && set.includes('b')));
});

test('OAuth token 明文迁移为加密存储，重复读取不再重写', async () => {
  const app = await loadBackground({
    local: {
      kimiOAuthAccounts: {
        accounts: [{
          id: 'acc-a',
          label: '账户 1',
          token: {
            access_token: 'plain-access',
            refresh_token: 'plain-refresh',
            expires_at: Math.floor(Date.now() / 1_000) + 3_600,
            expires_in: 3_600,
            scope: '',
            token_type: 'bearer'
          },
          needsReauth: false,
          addedAt: 1
        }],
        activeId: 'acc-a'
      }
    }
  });
  const store1 = await app.run('readAccountStore()');
  assert.equal(store1.accounts[0].token.access_token, 'plain-access');
  const persisted = app.local.kimiOAuthAccounts.accounts[0];
  assert.ok(persisted.tokenEnc);
  assert.equal(persisted.token, undefined);

  let writes = 0;
  const origSet = app.context.chrome.storage.local.set;
  app.context.chrome.storage.local.set = async (values) => {
    if (values && 'kimiOAuthAccounts' in values) writes += 1;
    return origSet(values);
  };
  await app.run('readAccountStore()');
  assert.equal(writes, 0);
});

test('fetchQuota 按账户 id 单飞：同账户并发共享一次网络请求', async () => {
  let quotaCalls = 0;
  const app = await loadBackground({
    local: {
      kimiOAuthAccounts: {
        accounts: [{
          id: 'acc-a',
          label: '账户 1',
          token: {
            access_token: 'a-access',
            refresh_token: 'a-refresh',
            expires_at: Math.floor(Date.now() / 1_000) + 3_600,
            expires_in: 3_600,
            scope: '',
            token_type: 'bearer'
          },
          needsReauth: false,
          addedAt: 1
        }],
        activeId: 'acc-a'
      }
    },
    fetchImpl: async (url) => {
      if (String(url).includes('/usages')) {
        quotaCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { ok: true, status: 200, async json() { return { limits: [], usage: { limit: 100, used: 10 } }; } };
      }
      throw new Error('unexpected fetch');
    }
  });
  const [r1, r2] = await Promise.all([
    app.run(`fetchQuota({ force: true })`),
    app.run(`fetchQuota({ force: true })`)
  ]);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(quotaCalls, 1);
});

test('额度预警在窗口回落后重新触发', async () => {
  const app = await loadBackground();
  await app.run(`evaluateQuotaAlerts({ usage: { limit: 100, used: 85 } })`);
  assert.equal(app.notifications.length, 1);
  assert.equal(app.notifications[0].id, 'quota-week-80');

  await app.run(`evaluateQuotaAlerts({ usage: { limit: 100, used: 70 } })`);
  await app.run(`evaluateQuotaAlerts({ usage: { limit: 100, used: 86 } })`);
  assert.equal(app.notifications.length, 2);
  assert.equal(app.notifications[1].id, 'quota-week-80');
});

test('MV3 SW 重启后将 scanning 状态恢复为失败', async () => {
  const app = await loadBackground({
    local: {
      kimiCliUsageState: { scanning: true, progress: 42 }
    }
  });
  // 拆分后恢复逻辑是 cli-scan.js 的导出函数，直接调用
  const { recoverInterruptedCliScan } = await import('../src/background/cli-scan.js');
  await recoverInterruptedCliScan();
  const state = app.local.kimiCliUsageState;
  assert.equal(state.scanning, false);
  assert.match(state.error, /中断/);
  assert.equal(state.progress, 42);
});
