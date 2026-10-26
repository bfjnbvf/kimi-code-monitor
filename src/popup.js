/**
 * 扩展弹窗（编排层）：模式识别 + 版本号 + 各板块装配。
 * 板块实现见 popup/ 目录：usage / accounts / external / tidy / pets。
 */
import { initMode } from './popup/shared.js';
import { initPopupLocale, applyPopupI18n } from './i18n.js';
import { initHostsSection } from './popup/hosts.js';
import { setCliPathHelp, refreshCliStatus } from './popup/usage.js';
import { refreshStatus } from './popup/accounts.js';
import { buildExternalSection, refreshExternalStatus } from './popup/external.js';
import { loadTidySettings, loadBookmarksFeature } from './popup/tidy.js';
import { loadPetSection } from './popup/pets.js';
import './popup/share-card.js';

// 初始化期禁用全部过渡动画（popup.css .kimi-preload）：存储读取完成后各开关
// 直接就位，消除每次打开弹窗时「HTML 默认值 → 存储值」的可见跳变动画
document.documentElement.classList.add('kimi-preload');

initMode();
document.getElementById('version').textContent = chrome.runtime.getManifest().version;

// 收藏页在扩展自有标签页打开（不依赖当前是否停在 Kimi 页面）。
// 功能总开关关闭时与页面内星标一致：入口隐藏，数据保留。
const openBookmarks = document.getElementById('open-bookmarks');
openBookmarks?.addEventListener('click', (event) => {
  event.preventDefault();
  chrome.runtime.sendMessage({ type: 'bookmarks.open' }).catch(() => {});
  window.close();
});
chrome.storage.local
  .get('kimiFeatureBookmarks')
  .then((stored) => {
    if (stored?.kimiFeatureBookmarks === false && openBookmarks) {
      openBookmarks.hidden = true;
      openBookmarks.style.display = 'none';
    }
  })
  .catch(() => {});

// 初始化调用均为 async：统一兜住 rejection，避免在扩展错误页留下噪音
function kick(promise) {
  Promise.resolve(promise).catch((error) => console.warn('[Kimi Popup] 初始化失败', error));
}

// 语言先行：板块渲染的文案（动态 t() 与静态 HTML 应用器）都依赖它
kick(
  (async () => {
    await initPopupLocale();
    applyPopupI18n(document);
    kick(initHostsSection());
    kick(refreshStatus());
    setCliPathHelp();
    kick(refreshCliStatus());
    buildExternalSection();
    kick(refreshExternalStatus());
    // 开关类板块全部就位后再恢复过渡动画（下一帧渲染起生效）
    await Promise.allSettled([loadTidySettings(), loadBookmarksFeature(), loadPetSection()]);
    requestAnimationFrame(() => document.documentElement.classList.remove('kimi-preload'));
  })()
);
