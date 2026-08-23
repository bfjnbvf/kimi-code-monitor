/**
 * Kimi Code Monitor 内容脚本（编排层）
 *
 * 职责边界：
 * - 只做装配与生命周期：初始化各域、路由轮询、storage/runtime 消息总线、销毁。
 * - 各域职责：panel-state（状态）、render（渲染）、widget-structure（DOM 与编辑）、
 *   pet-panel（宠物）、websocket-session（WS 状态机）、session（会话与快照）、
 *   quota（额度与授权）、usage-daily（CLI 长期统计与外部账户）。
 */
import { normalizeWidgetConfig } from './metrics.js';
import * as KimiCliUsage from './cli-usage.js';
import { stop as stopWalkthrough } from './content/walkthrough.js';
import {
  initPet,
  disposePet,
  petUpdateStatus,
  roamPetSetStatus,
  roamPetLoadConfig,
  handlePetStorageChanged
} from './content/pet-panel.js';
import { createWebSocketSession } from './content/websocket-session.js';
import {
  panel,
  resetMetrics
} from './content/panel-state.js';
import {
  initRender,
  disposeRender,
  renderChart,
  renderPetStats,
  updateBalance
} from './content/render.js';
import {
  initWidgetStructure,
  ensureWidget,
  applyWidgetConfig,
  loadWidgetConfig,
  renderWidgetStructure,
  setConnectionHint,
  maybeShowGuide,
  exitEditMode,
  cancelLongPress,
  clearDrag,
  isEditing,
  CONFIG_STORAGE_KEY,
  MINI_STORAGE_KEY,
  ONBOARDED_STORAGE_KEY
} from './content/widget-structure.js';
import { initQuota, fetchQuota, beginOAuth, setQuotaAuthRequired } from './content/quota.js';
import {
  initUsageDaily,
  disposeUsageDaily,
  loadUsageDaily,
  scheduleCliUsageRefresh,
  fetchExternalProviders
} from './content/usage-daily.js';
import {
  initSession,
  invalidateSession,
  startSession,
  handleAgentStatus,
  refreshSessionSeedFromScan,
  getCurrentSessionId,
  getSessionToken,
  setSessionToken,
  isSnapshotPending
} from './content/session.js';
import {
  initBookmarks,
  disposeBookmarks,
  handleBookmarksStorageChanged,
  repaintBookmarkStars,
  refreshBookmarksLocale
} from './content/bookmarks.js';
import { syncLocaleFromPage } from './i18n.js';

// ESM 静态依赖：缺失即加载失败，错误会直接在控制台可见，不再需要运行时守卫。

const QUOTA_INTERVAL_MS = 60_000;
const ROUTE_POLL_INTERVAL_MS = 1_000;
const CREDENTIAL_STORAGE_KEY = 'kimi-web.server-credential';

let quotaTimer = null;
let externalTimer = null;
let routeTimer = null;
let pageActivated = false;
let disposed = false;
let activationPromise = null;

/* ---------- 凭据与路由 ---------- */

function readCredential() {
  try {
    const raw = localStorage.getItem(CREDENTIAL_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return typeof parsed?.credential === 'string' ? parsed.credential : '';
  } catch (error) {
    console.warn('[Kimi Status] 无法读取本地凭据', error);
    return '';
  }
}

function getSessionId() {
  return location.pathname.match(/^\/sessions\/([^/?#]+)/)?.[1] || '';
}

/* ---------- 交互：手动刷新 ---------- */

function manualRefresh() {
  setConnectionHint('正在刷新…');
  // 手动刷新绕过 background 的 30s 缓存，强制重拉 5h/本周/本月额度
  fetchQuota(true);
  if (panel.cliUsageConnected) {
    chrome.runtime.sendMessage({ type: 'cli.usage.refresh' }).catch(() => {});
  }
  // 手动刷新才显式清零并重拉（自动重建走快照/本地记录裁决，不清零）
  resetMetrics();
  if (getCurrentSessionId() && getSessionToken()) startSession(getCurrentSessionId());
}

/* ---------- 域装配 ---------- */

initWidgetStructure({
  isDisposed: () => disposed,
  manualRefresh,
  beginOAuth,
  fetchQuota,
  fetchExternalProviders
});

initPet({
  isDisposed: () => disposed,
  getSessionId: () => getCurrentSessionId()
});

initRender({
  isDisposed: () => disposed,
  petUpdateStatus,
  roamPetSetStatus,
  onQuotaReset: () => fetchQuota()
});

initQuota({
  isDisposed: () => disposed,
  onContextInvalidated: () => dispose()
});

initUsageDaily({
  isDisposed: () => disposed
});

const conn = createWebSocketSession({
  isDisposed: () => disposed,
  getToken: () => getSessionToken(),
  getSessionId: () => getCurrentSessionId(),
  setConnectionHint,
  handleAgentStatus,
  scheduleCliUsageRefresh
});

initSession({
  isDisposed: () => disposed,
  conn
});

/* ---------- 生命周期 ---------- */

async function activatePage() {
  if (activationPromise) { await activationPromise; return; }
  if (pageActivated || disposed) return;
  setSessionToken(readCredential());
  const initialSessionId = getSessionId();
  maybeShowGuide();
  activationPromise = Promise.allSettled([
    fetchQuota(),
    loadWidgetConfig(),
    roamPetLoadConfig(),
    loadUsageDaily({ refreshIfStale: true }),
    startSession(initialSessionId)
  ]);
  await activationPromise;
  activationPromise = null;
  if (disposed) return;
  pageActivated = true;
  quotaTimer = setInterval(fetchQuota, QUOTA_INTERVAL_MS);
  externalTimer = setInterval(fetchExternalProviders, QUOTA_INTERVAL_MS);
}

function checkPageState() {
  // 扩展重载后 chrome.runtime.id 消失，残留脚本自我了断
  if (!chrome?.runtime?.id) {
    dispose();
    return;
  }
  if (disposed) return;
  if (!ensureWidget()) return;
  // 语言跟随 Kimi Web 设置（localStorage kimi-locale）：变化时重建面板结构与收藏 UI
  if (syncLocaleFromPage() && pageActivated) {
    renderWidgetStructure();
    refreshBookmarksLocale();
  }
  if (activationPromise) return;
  if (!pageActivated) {
    activatePage();
    return;
  }

  const nextToken = readCredential();
  const nextSessionId = getSessionId();
  if (nextToken !== getSessionToken()) {
    setSessionToken(nextToken);
    fetchQuota();
    startSession(nextSessionId);
    return;
  }
  if (nextSessionId !== getCurrentSessionId()) {
    startSession(nextSessionId);
    // 会话重绘后星标按新会话重新上色（observer 触发时路由可能还没切过来）
    repaintBookmarkStars();
  }
  else if (getCurrentSessionId() && getSessionToken() && !isSnapshotPending() && conn.isIdle()) {
    conn.connect();
  }
}

function handleStorageChanged(changes, area) {
  if (disposed || area !== 'local') return;
  // 其他页面写入的配置变化，实时重建面板结构
  if (changes[CONFIG_STORAGE_KEY]) {
    // 配置被删除（popup「重置布局」）：布局回默认，Mini 状态也复位为展开
    if (changes[CONFIG_STORAGE_KEY].newValue === undefined) {
      try {
        localStorage.removeItem(MINI_STORAGE_KEY);
      } catch (error) {
        // 忽略，仅本次保持当前模式
      }
    }
    // storage 回声（本页自己写入的）：配置内容未变则跳过，
    // 否则一次改动会双重建结构 + 双重销毁重建 Rive 实例
    const next = normalizeWidgetConfig(changes[CONFIG_STORAGE_KEY].newValue);
    if (JSON.stringify(next) === JSON.stringify(panel.widgetConfig)) {
      panel.widgetConfig = next;
    } else {
      applyWidgetConfig(next);
    }
  }
  const dailyKey = KimiCliUsage.DAILY_STORAGE_KEY;
  if (dailyKey && changes[dailyKey]) {
    panel.usageDailyCache = changes[dailyKey].newValue || {};
    renderChart();
    renderPetStats();
  }
  // 桌面宠物的开关/换素材/环视/大小变更由宠物域处理
  handlePetStorageChanged(changes);
  // 收藏数据变化（其他标签页写入）：刷新星标/目录行/收藏页
  handleBookmarksStorageChanged(changes);
  const stateKey = KimiCliUsage.STATE_STORAGE_KEY;
  if (stateKey && changes[stateKey]) {
    panel.cliUsageConnected = changes[stateKey].newValue?.connected === true;
    if (!panel.cliUsageConnected) panel.usageDailyCache = {};
    renderChart();
    renderPetStats();
  }
  if (!changes.kimiOnboardingResetAt) return;
  try {
    localStorage.removeItem(ONBOARDED_STORAGE_KEY);
  } catch (error) {
    // 忽略，下次刷新页面仍会显示
  }
  if (pageActivated) {
    maybeShowGuide();
    setQuotaAuthRequired(true);
    updateBalance(null);
  }
}

function handleRuntimeMessage(message) {
  if (disposed) return;
  if (message?.type === 'auth.completed') fetchQuota();
  if (message?.type === 'auth.switched') {
    // 切换账户：先展示该账户的缓存额度（若有），再强制刷新为最新值
    fetchQuota(false, { allowStale: true });
    fetchQuota(true);
  }
  if (message?.type === 'auth.cleared') {
    setQuotaAuthRequired(true);
    updateBalance(null);
  }
  if (message?.type === 'cli.usage.updated') {
    loadUsageDaily();
    // 后台重扫完成：空闲时按最新按会话汇总刷新当前面板底数
    refreshSessionSeedFromScan();
  }
  if (message?.type === 'cli.usage.disconnected') {
    loadUsageDaily();
  }
}

function handlePageHide(event) {
  if (event.persisted) {
    conn.disconnect();
    return;
  }
  dispose();
}

function handlePageShow(event) {
  if (event.persisted && !disposed) {
    checkPageState();
    // bfcache 恢复期间额度与本地汇总可能已过期，补一次拉取并按需触发重扫
    fetchQuota();
    loadUsageDaily({ refreshIfStale: true });
  }
}

function dispose() {
  if (disposed) return;
  disposed = true;
  invalidateSession();
  cancelLongPress();
  clearDrag();
  if (isEditing()) exitEditMode();
  disposePet();
  conn.clearToolStatus();
  // 侧栏改造的全局 class 一并移除，避免扩展重载后样式残留无法关闭
  document.documentElement.classList.remove('ksb-sidebar-tidy');
  conn.dispose();
  if (quotaTimer) clearInterval(quotaTimer);
  if (externalTimer) clearInterval(externalTimer);
  externalTimer = null;
  disposeRender();
  disposeUsageDaily();
  disposeBookmarks();
  if (routeTimer) clearInterval(routeTimer);
  // 扩展重载后 Chrome 不会自动重新注入 content script，
  // 残留脚本退出时一并移除 widget，避免留下一个永远灰色的「僵尸面板」
  if (panel.els?.widget) panel.els.widget.remove();
  // 引导层还注册了 document/window 监听，必须走它自己的 cleanup；DOM 兜底使用真实 id。
  try {
    stopWalkthrough();
  } catch (error) {
    document.getElementById('ksb-walk')?.remove();
  }
  try {
    chrome.storage.onChanged.removeListener(handleStorageChanged);
    chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
  } catch (error) {
    // 扩展上下文失效时监听器会随上下文一起销毁
  }
  window.removeEventListener('pagehide', handlePageHide);
  window.removeEventListener('pageshow', handlePageShow);
  panel.els = null;
}

function init() {
  checkPageState();
  routeTimer = setInterval(checkPageState, ROUTE_POLL_INTERVAL_MS);
  window.addEventListener('pagehide', handlePageHide);
  window.addEventListener('pageshow', handlePageShow);
  chrome.storage.onChanged.addListener(handleStorageChanged);
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  // 收藏域：DOM 注入与存储镜像，失败不影响面板
  initBookmarks({
    isDisposed: () => disposed,
    getSessionId: () => getCurrentSessionId()
  }).catch((error) => console.warn('[Kimi Status] 收藏功能初始化失败', error));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
