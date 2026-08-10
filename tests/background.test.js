const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const KimiMetrics = require('../metrics.js');
const backgroundSource = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

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

function loadBackground({ local = {}, fetchImpl = async () => { throw new Error('unexpected fetch'); } } = {}) {
  const localArea = storageArea(local);
  const sessionArea = storageArea();
  const notifications = [];
  const context = vm.createContext({
    AbortSignal,
    URLSearchParams,
    clearTimeout,
    console,
    crypto,
    fetch: fetchImpl,
    importScripts() {},
    KimiMetrics,
    navigator: { platform: 'test', userAgent: 'test' },
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
  vm.runInContext(backgroundSource, context, { filename: 'background.js' });
  return {
    context,
    local: localArea.data,
    notifications,
    run(expression) { return vm.runInContext(expression, context); }
  };
}

test('额度预警按原始百分比判断，不因四舍五入提前触发', async () => {
  const app = loadBackground();

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
  const app = loadBackground({
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
  const app = loadBackground({
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
      async json() { return { limits: [], usage: { limit: 100, used: 10 } }; }
    })
  });

  const state = await app.run(`(async () => {
    let alertDone = false;
    let snapshotDone = false;
    evaluateQuotaAlerts = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      alertDone = true;
    };
    recordQuotaSnapshot = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      snapshotDone = true;
    };
    const result = await fetchQuotaFresh();
    return { ok: result.ok, alertDone, snapshotDone };
  })()`);

  assert.equal(state.ok, true);
  assert.equal(state.alertDone, true);
  assert.equal(state.snapshotDone, true);
});

test('resetAndStartOAuth 会等待 pending 的旧授权流程结束后再发起新流程', async () => {
  let deviceAuthCalls = 0;
  let releaseStalledFlow;
  const stalled = new Promise((resolve) => { releaseStalledFlow = resolve; });
  const app = loadBackground({
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
