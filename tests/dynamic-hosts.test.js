// 动态站点授权（src/background/dynamic-hosts.js）：
// 验证登记表、内容脚本动态注册、CSP 动态规则与即时注入的联动。
import test from 'node:test';
import assert from 'node:assert/strict';

function installChromeStub() {
  const storage = new Map();
  const stubState = { nextTabs: [] };
  const calls = {
    registerContentScripts: [],
    unregisterContentScripts: [],
    updateDynamicRules: [],
    insertCSS: [],
    executeScript: [],
    tabsQuery: [],
    tabsReload: []
  };
  const listeners = { permissionsRemoved: null };
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key) => ({ [key]: storage.get(key) }),
        set: async (obj) => {
          for (const [k, v] of Object.entries(obj)) storage.set(k, v);
        },
        remove: async (key) => {
          storage.delete(key);
        }
      }
    },
    scripting: {
      registerContentScripts: async (defs) => calls.registerContentScripts.push(defs),
      unregisterContentScripts: async ({ ids }) => calls.unregisterContentScripts.push(ids),
      insertCSS: async (arg) => calls.insertCSS.push(arg),
      executeScript: async (arg) => calls.executeScript.push(arg)
    },
    declarativeNetRequest: {
      getDynamicRules: async () => [],
      updateDynamicRules: async (arg) => calls.updateDynamicRules.push(arg)
    },
    tabs: {
      query: async (arg) => {
        calls.tabsQuery.push(arg);
        return stubState.nextTabs;
      },
      reload: async (tabId, opts) => calls.tabsReload.push({ tabId, opts })
    },
    permissions: {
      contains: async (req) => stubState.permissionsGranted !== false,
      onRemoved: {
        addListener: (fn) => {
          listeners.permissionsRemoved = fn;
        }
      }
    }
  };
  return { storage, calls, listeners, stubState };
}

const { storage, calls, listeners, stubState } = installChromeStub();
const hosts = await import('../src/background/dynamic-hosts.js');

test('登记表为空时 URL 匹配表只有本机回环', async () => {
  assert.deepEqual(await hosts.kimiWebUrlPatterns(), hosts.BASE_URL_PATTERNS);
  assert.deepEqual(await hosts.listExtraWebHosts(), []);
});

test('授权：登记 origin、注册内容脚本、补 CSP 规则、刷新已开页面', async () => {
  const pattern = 'http://192.168.1.5:3000/*';
  const result = await hosts.grantExtraWebHost(pattern);
  assert.equal(result.ok, true);

  assert.deepEqual(storage.get('kimiExtraWebHosts'), [pattern]);
  assert.ok((await hosts.kimiWebUrlPatterns()).includes(pattern));

  const registered = calls.registerContentScripts.at(-1);
  assert.equal(registered[0].id, 'kimi-extra-web-hosts');
  assert.deepEqual(registered[0].matches, [pattern]);
  assert.deepEqual(registered[0].js, ['rive/rive.js', 'dist/content.js']);
  assert.deepEqual(registered[0].css, ['content.css']);

  const dnr = calls.updateDynamicRules.at(-1);
  assert.equal(dnr.addRules.length, 1);
  assert.equal(dnr.addRules[0].condition.urlFilter, '|http://192.168.1.5:3000/');
  assert.equal(dnr.addRules[0].action.responseHeaders[0].header, 'content-security-policy');
  // CSP 放行只作用于主文档：扩展（无 all_frames）从不在子框架运行，
  // 摘子框架 CSP 只有风险没有收益
  assert.deepEqual(dnr.addRules[0].condition.resourceTypes, ['main_frame']);

  // 已开标签页：按 origin 找到后整页刷新（bypassCache 让 DNR 摘掉 CSP）
  assert.deepEqual(calls.tabsQuery.at(-1), { url: [pattern] });
});

test('授权时已打开的匹配标签页会被 bypassCache 刷新', async () => {
  stubState.nextTabs = [{ id: 42 }, { id: 43 }];
  try {
    await hosts.grantExtraWebHost('http://172.16.0.9:4000/*');
    assert.deepEqual(calls.tabsReload, [
      { tabId: 42, opts: { bypassCache: true } },
      { tabId: 43, opts: { bypassCache: true } }
    ]);
  } finally {
    stubState.nextTabs = [];
    await hosts.revokeExtraWebHost('http://172.16.0.9:4000/*');
  }
});

test('重复授权同一 origin 不产生重复登记', async () => {
  await hosts.grantExtraWebHost('http://192.168.1.5:3000/*');
  assert.deepEqual(storage.get('kimiExtraWebHosts'), ['http://192.168.1.5:3000/*']);
});

test('非法 origin pattern 直接拒绝', async () => {
  await assert.rejects(() => hosts.grantExtraWebHost('192.168.1.5'), /无效的站点地址/);
  await assert.rejects(() => hosts.grantExtraWebHost(undefined), /无效的站点地址/);
  await assert.rejects(() => hosts.revokeExtraWebHost('ftp://x/*'), /无效的站点地址/);
});

test('后台复核 optional host 权限：未授权的 origin 不登记、不补 CSP 规则', async () => {
  stubState.permissionsGranted = false;
  try {
    await assert.rejects(() => hosts.grantExtraWebHost('http://192.168.5.5:9000/*'), /未授予站点访问权限/);
    assert.deepEqual(await hosts.listExtraWebHosts(), ['http://192.168.1.5:3000/*']);
  } finally {
    stubState.permissionsGranted = true;
  }
});

test('isAuthorizedContentUrl：回环直接放行，其余按登记表匹配', async () => {
  assert.equal(await hosts.isAuthorizedContentUrl('http://127.0.0.1:3000/sessions/x'), true);
  assert.equal(await hosts.isAuthorizedContentUrl('http://localhost/sessions/x'), true);
  assert.equal(await hosts.isAuthorizedContentUrl('http://192.168.1.5:3000/sessions/x'), true);
  assert.equal(await hosts.isAuthorizedContentUrl('http://192.168.1.5:3001/sessions/x'), false);
  assert.equal(await hosts.isAuthorizedContentUrl('https://evil.example.com/'), false);
  assert.equal(await hosts.isAuthorizedContentUrl('chrome-extension://abc/popup.html'), false);
  assert.equal(await hosts.isAuthorizedContentUrl('not a url'), false);
  assert.equal(await hosts.isAuthorizedContentUrl(undefined), false);
});

test('queryKimiWebTabs 合并本机与已授权 origin 查询标签页', async () => {
  await hosts.queryKimiWebTabs();
  assert.deepEqual(calls.tabsQuery.at(-1), {
    url: ['http://127.0.0.1/*', 'http://localhost/*', 'http://192.168.1.5:3000/*']
  });
});

test('浏览器侧撤销权限时 onRemoved 同步清理登记表', async () => {
  assert.equal(typeof listeners.permissionsRemoved, 'function');
  await listeners.permissionsRemoved({ origins: ['http://192.168.1.5:3000/*'] });
  // 监听器内部是异步链，给一拍让它落完
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(await hosts.listExtraWebHosts(), []);
  assert.deepEqual(await hosts.kimiWebUrlPatterns(), hosts.BASE_URL_PATTERNS);
});

test('撤销：登记表清空后注销动态内容脚本', async () => {
  const pattern = 'http://10.0.0.2:8080/*';
  await hosts.grantExtraWebHost(pattern);
  const before = calls.unregisterContentScripts.length;
  await hosts.revokeExtraWebHost(pattern);
  assert.deepEqual(await hosts.listExtraWebHosts(), []);
  assert.equal(calls.unregisterContentScripts.length, before + 1);
  // 空登记表不再重新注册
  assert.equal(calls.registerContentScripts.at(-1)[0].matches[0], pattern);
});
