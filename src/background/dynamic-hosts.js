/**
 * 动态站点授权：支持 kimi web --host 对外暴露的非本机地址。
 *
 * 静态 content_scripts 只匹配 127.0.0.1/localhost；用户在 popup 对某个
 * http(s) origin 点「在此站点启用」后，这里负责：
 * - 把 origin pattern 登记进 chrome.storage.local（REGISTRY_STORAGE_KEY）；
 * - 用 chrome.scripting 动态注册与静态一致的内容脚本（持久化，重启后仍生效）；
 * - 为该 origin 补一条动态 CSP 放行规则（与 rules/csp_relax.json 同动作）；
 * - 刷新已打开的匹配标签页（文档 CSP 只在加载时确定，刷新后注册脚本与
 *   CSP 规则同时生效，宠物 Rive 的 WASM 才能编译）。
 * 授权被移除（popup 撤销或浏览器站点设置）时同步清理以上三处。
 */
export const BASE_URL_PATTERNS = ['http://127.0.0.1/*', 'http://localhost/*'];

const REGISTRY_STORAGE_KEY = 'kimiExtraWebHosts';
const CONTENT_SCRIPT_ID = 'kimi-extra-web-hosts';
// 动态 CSP 规则 id 段：与 rules/csp_relax.json 的静态规则（id 1）错开
const CSP_RULE_ID_BASE = 1000;

const CONTENT_SCRIPT_FILES = ['rive/rive.js', 'dist/content.js'];
const CONTENT_CSS_FILES = ['content.css'];

async function loadRegistry() {
  const stored = await chrome.storage.local.get(REGISTRY_STORAGE_KEY);
  const list = stored[REGISTRY_STORAGE_KEY];
  return Array.isArray(list) ? list.filter((p) => typeof p === 'string') : [];
}

async function saveRegistry(list) {
  if (list.length) {
    await chrome.storage.local.set({ [REGISTRY_STORAGE_KEY]: list });
  } else {
    await chrome.storage.local.remove(REGISTRY_STORAGE_KEY);
  }
}

// pattern（http://host:port/*）→ 主帧 URL 左锚过滤串，供 DNR urlFilter 使用
function patternToUrlFilter(pattern) {
  return `|${pattern.replace(/\*$/, '')}`;
}

async function syncContentScripts(registry) {
  await chrome.scripting
    .unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] })
    .catch(() => {});
  if (!registry.length) return;
  await chrome.scripting.registerContentScripts([
    {
      id: CONTENT_SCRIPT_ID,
      matches: registry,
      js: CONTENT_SCRIPT_FILES,
      css: CONTENT_CSS_FILES,
      runAt: 'document_start',
      persistAcrossSessions: true
    }
  ]);
}

async function syncCspRules(registry) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing
    .map((rule) => rule.id)
    .filter((id) => id >= CSP_RULE_ID_BASE);
  // 只放行主文档：扩展（无 all_frames）从不在子框架运行，摘子框架 CSP
  // 只有风险没有收益。远程 origin 摘整页 CSP 本就是重斧——放行 WASM 编译
  // 无法在 DNR 里按指令粒度改写（append 只会更严），删头是保页面不坏的
  // 唯一可行操作，因此把作用面压到最小。
  const addRules = registry.map((pattern, index) => ({
    id: CSP_RULE_ID_BASE + index,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      responseHeaders: [{ header: 'content-security-policy', operation: 'remove' }]
    },
    condition: {
      urlFilter: patternToUrlFilter(pattern),
      resourceTypes: ['main_frame']
    }
  }));
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

// 授权前就已打开的页面不会被动态注册覆盖，且文档 CSP 在加载时已确定、
// 无法追溯修改（宠物 Rive 的 WASM 编译依赖 CSP 放行），直接整页刷新最干净。
// bypassCache 确保文档重新走网络，DNR 规则才有机会摘掉 CSP 头。
async function reloadOpenTabs(patterns) {
  const tabs = await chrome.tabs.query({ url: patterns }).catch(() => []);
  for (const tab of tabs) {
    await chrome.tabs.reload(tab.id, { bypassCache: true }).catch(() => {});
  }
}

// 本机回环 + 已授权 origin 的完整匹配表，供各处 tabs.query 使用
export async function kimiWebUrlPatterns() {
  return [...BASE_URL_PATTERNS, ...(await loadRegistry())];
}

// 消息来源守卫用：该 URL 是否属于「静态注入的回环页面」或「已动态授权的站点」。
// 内容脚本只可能出现在这两类 origin 上；其余一律视为不可信来源。
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost']);

export async function isAuthorizedContentUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (LOOPBACK_HOSTNAMES.has(parsed.hostname)) return true;
  const registry = await loadRegistry();
  return registry.includes(`${parsed.protocol}//${parsed.host}/*`);
}

export async function queryKimiWebTabs() {
  try {
    return await chrome.tabs.query({ url: await kimiWebUrlPatterns() });
  } catch {
    return [];
  }
}

export async function listExtraWebHosts() {
  return loadRegistry();
}

function assertOriginPattern(pattern) {
  if (typeof pattern !== 'string' || !/^https?:\/\/[^/]+\/\*$/.test(pattern)) {
    throw new Error('无效的站点地址');
  }
}

export async function grantExtraWebHost(originPattern) {
  assertOriginPattern(originPattern);
  // 后台复核权限：登记/CSP 规则只应发生在浏览器 optional host 权限真正授予
  // 之后（popup 已在用户手势里 request，这里防的是绕过 popup 直接发消息）。
  const granted = await chrome.permissions.contains({ origins: [originPattern] });
  if (!granted) throw new Error('未授予站点访问权限');
  const registry = await loadRegistry();
  if (!registry.includes(originPattern)) {
    registry.push(originPattern);
    await saveRegistry(registry);
  }
  await syncContentScripts(registry);
  await syncCspRules(registry);
  await reloadOpenTabs([originPattern]);
  return { ok: true };
}

export async function revokeExtraWebHost(originPattern) {
  assertOriginPattern(originPattern);
  const registry = (await loadRegistry()).filter((p) => p !== originPattern);
  await saveRegistry(registry);
  await syncContentScripts(registry);
  await syncCspRules(registry);
  return { ok: true };
}

// 用户在浏览器站点设置里撤销权限时，同步清掉登记表与动态规则
chrome.permissions?.onRemoved?.addListener((permissions) => {
  const removed = new Set(permissions.origins || []);
  if (!removed.size) return;
  loadRegistry()
    .then(async (registry) => {
      const kept = registry.filter((p) => !removed.has(p));
      if (kept.length === registry.length) return;
      await saveRegistry(kept);
      await syncContentScripts(kept);
      await syncCspRules(kept);
    })
    .catch((error) => console.warn('[Kimi Status] 清理已撤销站点授权失败', error));
});

// 安装/更新时对齐动态注册与登记表（注册与 DNR 动态规则本身跨会话持久，
// SW 日常唤醒无需重同步；权限变化由 grant/revoke/onRemoved 各自维护）
export async function syncExtraWebHosts() {
  const registry = await loadRegistry();
  await syncContentScripts(registry);
  await syncCspRules(registry);
}
