import vm from 'node:vm';

// background 拆分后（src/background/ 按域分模块），测试直接 import 真实模块，
// 不再做源码文本改写。模块级状态（缓存 Map、单飞 Promise）在用例间共享，
// 需要隔离的状态由各用例自行清理（quotaCacheByAccount 暴露出去就是这个目的）。
//
// 模块顶层有 chrome.* 监听器注册，必须先装好全局 mock 再 import，故全部走动态导入。
let modules = null;

async function loadModules() {
  if (modules) return modules;
  const [store, oauth, quota] = await Promise.all([
    import('../src/background/store.js'),
    import('../src/background/oauth.js'),
    import('../src/background/quota.js')
  ]);
  modules = { store, oauth, quota };
  return modules;
}

/**
 * 把 background 各域的函数暴露到 globalThis（run() 表达式经 vm context 调用），
 * 并按入口同样的方式装配 oauth → quota 的失效回调。
 * 调用前测试需先装好 chrome/indexedDB 等全局 mock。
 */
export async function loadBackgroundModule() {
  const { store, oauth, quota } = await loadModules();
  // 模块级缓存跨用例共享（拆分后不再有每用例独立模块），装配前清空以保持用例隔离
  quota.quotaCacheByAccount.clear();
  oauth.initOAuth({
    invalidateQuotaCache: quota.invalidateQuotaCache,
    clearQuotaAlertState: quota.clearAccountAlertState
  });
  const exposed = {
    authStatus: oauth.authStatus,
    readAccountStore: oauth.readAccountStore,
    startOAuth: oauth.startOAuth,
    switchAccount: oauth.switchAccount,
    renameAccount: oauth.renameAccount,
    removeAccount: oauth.removeAccount,
    refreshTokenSingleFlight: oauth.refreshTokenSingleFlight,
    resetAndStartOAuth: oauth.resetAndStartOAuth,
    fetchQuota: quota.fetchQuota,
    fetchQuotaFresh: quota.fetchQuotaFresh,
    evaluateQuotaAlerts: quota.evaluateQuotaAlerts,
    recordQuotaSnapshot: quota.recordQuotaSnapshot,
    withStorageLock: store.withStorageLock
  };
  for (const [name, fn] of Object.entries(exposed)) {
    globalThis[name] = fn;
  }
  globalThis.quotaCacheByAccount = quota.quotaCacheByAccount;
}

/**
 * 在 vm context 里执行表达式，复用原来 tests 的 run('...') 风格。
 * context 里已有 chrome/indexedDB/fetch 等 mock 以及暴露出来的 background 函数。
 */
export function runInBackgroundContext(expression, context) {
  return vm.runInContext(expression, context, { filename: 'background-test-context.js' });
}
