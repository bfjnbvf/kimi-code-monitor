/**
 * 扩展弹窗（编排层）：模式识别 + 版本号 + 各板块装配。
 * 板块实现见 popup/ 目录：usage / accounts / external / rename / tidy / pets。
 */
import { initMode } from './popup/shared.js';
import { initPopupLocale, applyPopupI18n } from './i18n.js';
import { initHostsSection } from './popup/hosts.js';
import { setCliPathHelp, refreshCliStatus } from './popup/usage.js';
import { refreshStatus } from './popup/accounts.js';
import { buildExternalSection, refreshExternalStatus } from './popup/external.js';
import { loadRenameSettings } from './popup/rename.js';
import { loadTidySettings, loadBookmarksFeature } from './popup/tidy.js';
import './popup/pets.js';
import './popup/share-card.js';

initMode();
document.getElementById('version').textContent = chrome.runtime.getManifest().version;

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
    kick(loadRenameSettings());
    kick(loadTidySettings());
    kick(loadBookmarksFeature());
  })()
);
