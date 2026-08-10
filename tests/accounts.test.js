const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const KimiMetrics = require('../metrics.js');
const backgroundSource = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

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

function makeToken(prefix, expiresIn = 3_600) {
  return {
    access_token: `${prefix}-access`,
    refresh_token: `${prefix}-refresh`,
    expires_at: Math.floor(Date.now() / 1_000) + expiresIn,
    expires_in: expiresIn,
    scope: '',
    token_type: 'bearer'
  };
}

function makeAccount(id, label, token, extra = {}) {
  return { id, label, token, needsReauth: false, addedAt: 1, ...extra };
}

function seedStore(accounts, activeId) {
  return { kimiOAuthAccounts: { accounts, activeId } };
}

function okJson(data) {
  return { ok: true, status: 200, async json() { return data; } };
}

function failJson(status, data) {
  return { ok: false, status, async json() { return data; } };
}

// 设备授权 + token 端点都直接成功的 fetch；token 端点按 refresh_token 回显新 access token
function oauthFetchImpl() {
  return async (url) => {
    if (String(url).includes('device_authorization')) {
      return okJson({
        device_code: 'device-1',
        user_code: 'CODE-1',
        expires_in: 900,
        interval: 5,
        verification_uri_complete: 'https://auth.kimi.com/activate'
      });
    }
    if (String(url).includes('/token')) {
      return okJson({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3_600 });
    }
    throw new Error('unexpected fetch');
  };
}

test('账户表建立：消息注册、旧 token 迁移、授权新建与自动编号、失效重授权不新建', async () => {
  assert.match(backgroundSource, /'oauth\.add': addAccountOAuth/);
  assert.match(backgroundSource, /'oauth\.reauth': reauthAccountOAuth/);
  assert.match(backgroundSource, /'accounts\.switch': switchAccount/);
  assert.match(backgroundSource, /'accounts\.remove': removeAccount/);
  assert.match(backgroundSource, /'accounts\.rename': renameAccount/);

  // 旧版单 token 自动迁移为首个账户（账户 1）并设为激活，旧键删除
  const legacy = loadBackground({ local: { kimiOAuthToken: makeToken('legacy') } });
  const migrated = await legacy.run('authStatus()');
  assert.equal(migrated.ok, true);
  assert.equal(migrated.authorized, true);
  assert.equal(migrated.accounts.length, 1);
  assert.equal(migrated.accounts[0].label, '账户 1');
  assert.equal(migrated.accounts[0].active, true);
  assert.equal(migrated.accounts[0].needsReauth, false);
  assert.ok(!('kimiOAuthToken' in legacy.local));
  assert.equal(legacy.local.kimiOAuthAccounts.accounts[0].token.access_token, 'legacy-access');
  assert.equal(legacy.local.kimiOAuthAccounts.activeId, legacy.local.kimiOAuthAccounts.accounts[0].id);

  // 设备授权完成即新建账户并成为激活账户，备注名缺省时自动编号
  const adding = loadBackground({ fetchImpl: oauthFetchImpl() });
  await adding.run(`startOAuth({ forceNew: true, label: '工作号' })`);
  let store = adding.local.kimiOAuthAccounts;
  assert.equal(store.accounts.length, 1);
  assert.equal(store.accounts[0].label, '工作号');
  assert.equal(store.accounts[0].token.access_token, 'new-access');
  assert.equal(store.accounts[0].needsReauth, false);
  assert.equal(store.activeId, store.accounts[0].id);
  await adding.run(`startOAuth({ forceNew: true })`);
  store = adding.local.kimiOAuthAccounts;
  assert.equal(store.accounts.length, 2);
  assert.equal(store.accounts[1].label, '账户 1');
  assert.equal(store.activeId, store.accounts[1].id);

  // 激活账户失效时，无参数 startOAuth 视为重新授权该账户（不新建）
  const reauth = loadBackground({
    local: seedStore([makeAccount('acc-a', '主号', null, { needsReauth: true })], 'acc-a'),
    fetchImpl: oauthFetchImpl()
  });
  await reauth.run('startOAuth()');
  store = reauth.local.kimiOAuthAccounts;
  assert.equal(store.accounts.length, 1);
  assert.equal(store.accounts[0].id, 'acc-a');
  assert.equal(store.accounts[0].label, '主号');
  assert.equal(store.accounts[0].token.access_token, 'new-access');
  assert.equal(store.accounts[0].needsReauth, false);
  assert.equal(store.activeId, 'acc-a');
});

test('账户操作：切换、移除（自动切换/清空回未授权/预警清理）、改名及错误分支', async () => {
  const app = loadBackground({
    local: {
      ...seedStore(
        [makeAccount('acc-a', '账户 1', makeToken('a')), makeAccount('acc-b', '账户 2', makeToken('b'))],
        'acc-a'
      ),
      quotaAlertState: { 'acc-a': { week: { level: 80 } }, 'acc-b': { week: { level: 80 } } }
    }
  });

  // 切换：activeId 更新并反映到 authStatus，不存在的 id 报错
  assert.equal((await app.run(`switchAccount({ id: 'acc-x' })`)).ok, false);
  const switched = await app.run(`switchAccount({ id: 'acc-b' })`);
  assert.equal(switched.ok, true);
  assert.equal(switched.activeId, 'acc-b');
  let status = await app.run('authStatus()');
  assert.equal(status.activeId, 'acc-b');
  assert.equal(status.accounts.find((a) => a.id === 'acc-b').active, true);
  assert.equal(status.accounts.find((a) => a.id === 'acc-a').active, false);

  // 改名：正常改名（去首尾空格）、空备注拒绝、不存在的 id 报错
  const renamed = await app.run(`renameAccount({ id: 'acc-a', label: '  小号  ' })`);
  assert.equal(renamed.ok, true);
  assert.equal(app.local.kimiOAuthAccounts.accounts[0].label, '小号');
  assert.equal((await app.run(`renameAccount({ id: 'acc-a', label: '   ' })`)).ok, false);
  assert.equal((await app.run(`renameAccount({ id: 'acc-x', label: 'x' })`)).ok, false);

  // 移除激活的 acc-b（当前激活）：自动切到 acc-a，acc-b 的预警状态一并清除
  assert.equal((await app.run(`removeAccount({ id: 'acc-x' })`)).ok, false);
  const removed = await app.run(`removeAccount({ id: 'acc-b' })`);
  assert.equal(removed.ok, true);
  assert.equal(removed.activeId, 'acc-a');
  assert.ok(!('acc-b' in (app.local.quotaAlertState || {})));
  assert.ok('acc-a' in app.local.quotaAlertState);

  // 移除最后一个：回到未授权状态
  const last = await app.run(`removeAccount({ id: 'acc-a' })`);
  assert.equal(last.ok, true);
  assert.equal(last.activeId, null);
  status = await app.run('authStatus()');
  assert.equal(status.authorized, false);
  assert.equal(status.accounts.length, 0);
});

test('token 刷新按账户 id 单飞：同账户共享进行中 promise，跨账户互不阻塞', async () => {
  const refreshBodies = [];
  const app = loadBackground({
    local: seedStore(
      [
        makeAccount('acc-a', '账户 1', makeToken('a', -100)),
        makeAccount('acc-b', '账户 2', makeToken('b', -100))
      ],
      'acc-a'
    ),
    fetchImpl: async (url, options) => {
      if (String(url).includes('/token')) {
        const body = String(options?.body || '');
        refreshBodies.push(body);
        const refreshToken = /refresh_token=([^&]+)/.exec(body)?.[1] || 'x';
        return okJson({ access_token: `${refreshToken}-new-access`, expires_in: 3_600 });
      }
      throw new Error('unexpected fetch');
    }
  });

  const results = await app.run(`(async () => {
    const store = await readAccountStore();
    const [a, b] = store.accounts;
    const tokens = await Promise.all([
      refreshTokenSingleFlight(a.id, a.token),
      refreshTokenSingleFlight(a.id, a.token),
      refreshTokenSingleFlight(b.id, b.token),
      refreshTokenSingleFlight(b.id, b.token)
    ]);
    return tokens.map((token) => token.access_token);
  })()`);

  // 每个账户只发一次刷新请求
  assert.equal(refreshBodies.length, 2);
  // vm 上下文里的数组与测试 realm 原型不同，按内容比较
  assert.deepEqual(results.join('|'), [
    'a-refresh-new-access',
    'a-refresh-new-access',
    'b-refresh-new-access',
    'b-refresh-new-access'
  ].join('|'));
  // 两个账户的新 token 各自落盘
  const store = app.local.kimiOAuthAccounts;
  assert.equal(store.accounts[0].token.access_token, 'a-refresh-new-access');
  assert.equal(store.accounts[1].token.access_token, 'b-refresh-new-access');
});

test('额度 401：刷新失败或刷新后重试仍 401 都标记该账户需重新授权，不影响其他账户', async () => {
  // 刷新失败：标记失效，另一账户原样保留且切过去即可正常拉取
  const failing = loadBackground({
    local: seedStore(
      [makeAccount('acc-a', '账户 1', makeToken('a')), makeAccount('acc-b', '账户 2', makeToken('b'))],
      'acc-a'
    ),
    fetchImpl: async (url, options) => {
      const auth = options?.headers?.Authorization || '';
      if (String(url).includes('/usages')) {
        if (auth.includes('b-access')) return okJson({ limits: [], usage: { limit: 100, used: 10 } });
        return failJson(401, { error: 'invalid_token' });
      }
      if (String(url).includes('/token')) return failJson(401, { error: 'invalid_grant' });
      throw new Error('unexpected fetch');
    }
  });
  const failed = await failing.run(`fetchQuota({ force: true })`);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'AUTH_REQUIRED');
  let store = failing.local.kimiOAuthAccounts;
  assert.equal(store.accounts[0].needsReauth, true);
  assert.equal(store.accounts[0].token, null);
  assert.equal(store.accounts[1].needsReauth, false);
  assert.equal(store.accounts[1].token.access_token, 'b-access');
  await failing.run(`switchAccount({ id: 'acc-b' })`);
  assert.equal((await failing.run(`fetchQuota({ force: true })`)).ok, true);
  assert.equal(failing.local.kimiOAuthAccounts.accounts[0].needsReauth, true);

  // 刷新成功但重试仍 401：同样标记
  const retrying = loadBackground({
    local: seedStore([makeAccount('acc-a', '账户 1', makeToken('a'))], 'acc-a'),
    fetchImpl: async (url) => {
      if (String(url).includes('/usages')) return failJson(401, { error: 'invalid_token' });
      if (String(url).includes('/token')) {
        return okJson({ access_token: 'refreshed-access', refresh_token: 'refreshed-refresh', expires_in: 3_600 });
      }
      throw new Error('unexpected fetch');
    }
  });
  const result = await retrying.run(`fetchQuota({ force: true })`);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AUTH_REQUIRED');
  const account = retrying.local.kimiOAuthAccounts.accounts[0];
  assert.equal(account.needsReauth, true);
  assert.equal(account.token, null);
});

test('缓存与预警按账户隔离：allowStale 命中旧缓存，同一阈值各账户各通知一次', async () => {
  // 额度缓存按账户隔离：切换后 allowStale 先返回旧缓存，常规拉取再刷新
  let quotaCalls = 0;
  const caching = loadBackground({
    local: seedStore(
      [makeAccount('acc-a', '账户 1', makeToken('a')), makeAccount('acc-b', '账户 2', makeToken('b'))],
      'acc-a'
    ),
    fetchImpl: async (url, options) => {
      if (String(url).includes('/usages')) {
        quotaCalls += 1;
        const used = (options?.headers?.Authorization || '').includes('b-access') ? 50 : 10;
        return okJson({ limits: [], usage: { limit: 100, used } });
      }
      throw new Error('unexpected fetch');
    }
  });
  assert.equal((await caching.run(`fetchQuota()`)).data.usage.used, 10);
  await caching.run(`switchAccount({ id: 'acc-b' })`);
  assert.equal((await caching.run(`fetchQuota()`)).data.usage.used, 50);
  assert.equal(quotaCalls, 2);
  // 切回 acc-a 并把它的缓存改旧：allowStale 命中旧缓存，不发新请求
  await caching.run(`switchAccount({ id: 'acc-a' })`);
  await caching.run(`(async () => {
    const store = await readAccountStore();
    quotaCacheByAccount.get(store.activeId).fetchedAt = 0;
  })()`);
  assert.equal((await caching.run(`fetchQuota({ allowStale: true })`)).data.usage.used, 10);
  assert.equal(quotaCalls, 2);
  // 常规拉取发现缓存过期，重新请求
  assert.equal((await caching.run(`fetchQuota()`)).data.usage.used, 10);
  assert.equal(quotaCalls, 3);

  // 额度预警状态按账户隔离，同一阈值各账户各通知一次；同账户重复越级不重复通知
  const alerting = loadBackground();
  await alerting.run(`evaluateQuotaAlerts({ usage: { limit: 100, used: 85 } }, 'acc-a')`);
  await alerting.run(`evaluateQuotaAlerts({ usage: { limit: 100, used: 85 } }, 'acc-b')`);
  assert.equal(alerting.notifications.length, 2);
  await alerting.run(`evaluateQuotaAlerts({ usage: { limit: 100, used: 86 } }, 'acc-a')`);
  assert.equal(alerting.notifications.length, 2);
  assert.equal(alerting.local.quotaAlertState['acc-a'].week.level, 80);
  assert.equal(alerting.local.quotaAlertState['acc-b'].week.level, 80);
});
