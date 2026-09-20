/**
 * 独立面板页入口（macOS App 的 WKWebView 菜单栏弹层加载）
 *
 * 与 content.js 的职责差异：不注入 Kimi Web 页面、不碰 chrome.* / 页面宿主，
 * 数据全部由 Swift 经 window.__vibepal.push 推送（protocol 见 panel-app/bridge.js）；
 * 面板本体（widget-structure）、渲染（render）、状态（panel-state）、宠物
 * （pet-panel）、i18n 与 content.js 完全共用，样式用 content.css 原样引用。
 *
 * 装配顺序：shims（chrome.* 替代）→ bridge（push 入口）→ 共享模块 → 挂载 widget
 * → 注入依赖钩子 → 读配置 → 桥接就绪。新手引导 / 会话快照 / WS 连接管理不搬
 * （连接与游标在 Swift 侧）。
 */

import './panel-app/shims.js';
import { installBridge, markBridgeReady, getSessionId } from './panel-app/bridge.js';
import {
  applyWidgetConfig,
  initWidgetStructure,
  loadWidgetConfig,
  mountWidget,
  CONFIG_STORAGE_KEY
} from './content/widget-structure.js';
import { initRender, renderAll } from './content/render.js';
import { initPet, petUpdateStatus } from './content/pet-panel.js';
import { panel, resetMetrics } from './content/panel-state.js';
import { syncLocaleFromPage } from './i18n.js';

// 面板页默认布局：与扩展侧栏的默认配置同口径，但全部模块可见
// （侧栏默认把标题行 / 上轮耗时 / 子代理 / 外部账户收进隐藏区）。
// 首次启动写入 storage 后，用户在面板里的长按编辑/拖拽/≡ 菜单照常持久化生效。
const PANEL_WIDGET_CONFIG = {
  version: 3,
  modules: {
    header: { show: 'full', span: 2, showBalance: true, balanceLink: 'subscription' },
    input: { show: 'full', span: 1 },
    cache: { show: 'full', span: 1 },
    output: { show: 'full', span: 1 },
    speed: { show: 'full', span: 1 },
    duration: { show: 'full', span: 1 },
    quota5h: { show: 'mini', span: 1, pace: true, resetFormat: 'countdown' },
    quotaWeek: { show: 'mini', span: 1, pace: true, resetFormat: 'countdown' },
    usageChart: { show: 'full', span: 2, chartRange: 'week' },
    pet: { show: 'mini', span: 2, stat: 'daily', sidebarTidy: true, ballLink: 'none' },
    agents: { show: 'full', span: 2, hiddenAgents: [] },
    external: { show: 'full', span: 1, hiddenAccounts: [] }
  },
  orderFull: ['header', 'input', 'cache', 'output', 'speed', 'duration', 'usageChart', 'agents', 'external'],
  orderMini: ['pet', 'quota5h', 'quotaWeek'],
  orderHidden: []
};

// 面板 → Swift 的请求转发（无 Swift 桥时静默丢弃，面板行为不受影响）
function askSwift(message) {
  try {
    if (typeof globalThis.__vibepalAsk === 'function') globalThis.__vibepalAsk(message);
  } catch (error) {
    // 转发失败不影响面板
  }
}

/* ---------- 装配 ---------- */

initWidgetStructure({
  isDisposed: () => false,
  // 标题行点击：本地数值与折线样本清空重计，同时让 Swift 侧重推全量数据
  manualRefresh: () => {
    resetMetrics();
    panel.sessionSamples.length = 0;
    panel.turnDurations.length = 0;
    renderAll();
    askSwift({ type: 'refresh' });
  },
  // 授权 / 额度 / 外部账户的拉取都在 Swift 侧，这里只转发意图
  beginOAuth: () => askSwift({ type: 'auth.begin' }),
  fetchQuota: () => askSwift({ type: 'refresh' }),
  fetchExternalProviders: () => {}
});

initPet({
  isDisposed: () => false,
  getSessionId
});

initRender({
  isDisposed: () => false,
  petUpdateStatus,
  // 桌面宠物（roam pet）不启用
  roamPetSetStatus: () => {},
  // 额度到头：让 Swift 侧重推最新额度
  onQuotaReset: () => askSwift({ type: 'refresh' })
});

installBridge();

const host = document.createElement('div');
host.id = 'ksb-panel-host';
document.body.appendChild(host);
mountWidget(host);

// 语言跟随 kimi-locale（Swift 侧如需英文可预先写入该键）；
// 缺省时保持 i18n 模块默认的中文，不跟系统语言走
try {
  if (localStorage.getItem('kimi-locale')) syncLocaleFromPage();
} catch (error) {
  // localStorage 不可用时保持默认中文
}

async function bootstrap() {
  try {
    const stored = await chrome.storage.local.get(CONFIG_STORAGE_KEY);
    if (stored[CONFIG_STORAGE_KEY] == null) {
      await chrome.storage.local.set({ [CONFIG_STORAGE_KEY]: PANEL_WIDGET_CONFIG }).catch(() => {
        // 存储不可用时仅本次会话生效，不影响渲染
      });
    }
    await loadWidgetConfig();
  } catch (error) {
    console.warn('[Kimi Status] 面板配置加载失败', error);
    applyWidgetConfig(PANEL_WIDGET_CONFIG);
  }
  markBridgeReady();
  // 页面内联脚本（?mock=1 演示数据）就绪信号
  window.dispatchEvent(new Event('vibepal:panel-ready'));
}

bootstrap();
