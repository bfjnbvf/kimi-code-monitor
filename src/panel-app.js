/**
 * 独立面板页入口（桌面补丁注入模式专用）
 *
 * 由补丁 loader 注入 Kimi Code 桌面端页面（desktop-dist/index.html 的
 * script 标签）：不注入自己的页面、不碰 chrome.* 真实 API（shims 兜底）、
 * 数据由 direct.js 直连同机 kap-server（WS 事件流 + REST 轮询）与 loader
 * 的 usage-daily/external 快照，经 window.__vibepal.push 进入渲染层。
 * 面板本体（widget-structure）、渲染（render）、状态（panel-state）、
 * 宠物（pet-panel）、i18n 与 content.js 完全共用，样式用 content.css 原样引用。
 *
 * 装配顺序：shims（chrome.* 替代）→ push 总线（bridge.js）→ 共享模块 →
 * 挂载 widget → 读配置 → 总线就绪 → 直连启动 → 就绪事件。
 * 新手引导 / 会话快照 / WS 连接管理不搬（连接与游标在 direct.js 侧）。
 */

import './panel-app/shims.js';
import { installBridge, markBridgeReady, getSessionId, installStatusTicker } from './panel-app/bridge.js';
import { startDirectMode } from './panel-app/direct.js';
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

// 独立面板标记：渲染层据此切换状态短词（扩展里对应位置显示「需连接」）
panel.standaloneMode = true;

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

/* ---------- 装配 ---------- */

initWidgetStructure({
  isDisposed: () => false,
  // 标题行点击：本地数值与折线样本清空重计（额度/统计由 direct.js 轮询与
  // loader 快照在下一周期自动补齐，无需额外请求）
  manualRefresh: () => {
    resetMetrics();
    panel.sessionSamples.length = 0;
    panel.turnDurations.length = 0;
    renderAll();
  },
  // 授权 / 额度 / 外部账户的数据都由直连与 loader 快照提供，这里只留空桩
  // （widget-structure 与扩展共用，注入模式无对应动作）
  beginOAuth: () => {},
  fetchQuota: () => {},
  fetchExternalProviders: () => {},
  // 无「连接本地 CLI」目录授权动作：锁位由 widget-structure 改述为统计积累中
  cliLockAccumulate: true
});

initPet({
  isDisposed: () => false,
  getSessionId
});

initRender({
  isDisposed: () => false,
  petUpdateStatus,
  // 桌面宠物（roam pet）不启用
  roamPetSetStatus: () => {}
});

installBridge();

// 宿主挂载：注入器（loader）提供挂载点（aside.side > .col 里 side-footer 之前）；
// 挂载点缺失时退化为页面级浮动面板（jsdom 测试走这条）
const host = document.createElement('div');
host.id = 'ksb-panel-host';
if (typeof globalThis.__vibepalMountInto === 'function') {
  globalThis.__vibepalMountInto(host);
} else {
  document.body.appendChild(host);
}
mountWidget(host);

// 语言跟随 kimi-locale（桌面端按系统语言预写该键）；
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
  // 状态文案 ticker：锁位句子 + 渲染层短词的数据源
  installStatusTicker();
  // 直连同机 kap-server（WS 事件流 + REST 轮询）。直连启动失败不拖垮面板：
  // 就绪信号必须照常派发（loader 靠它补推数据）
  try {
    startDirectMode();
  } catch (error) {
    console.error('[Kimi Status] 直连模式启动失败', error);
  }
  // loader 的就绪信号：补推直连启动前到达的 usage-daily / external 快照
  window.dispatchEvent(new Event('vibepal:panel-ready'));
}

bootstrap();
