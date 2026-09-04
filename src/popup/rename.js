/**
 * 新会话自动命名板块（v2）：仅总开关。
 * v3.4.0 起命名执行走系统「生成标题」（content 直调 title/generate），
 * 模型选择 / emoji / 用量显示随旧管线移除（见 popup/rename.js 的 git 历史）。
 */
const RENAME_SETTINGS_STORAGE_KEY = 'sessionRenameSettings';
const renameAutoToggle = document.getElementById('rename-auto-toggle');
const extRenameBlock = document.getElementById('ext-rename-block');

let renameSettings = { autoEnabled: false };

function saveRenameSettings() {
  // 保留存储里的其他旧字段（emojiEnabled/modelSource 已停用，仅不读写）
  chrome.storage.local.set({ [RENAME_SETTINGS_STORAGE_KEY]: { ...renameSettings } }).catch(() => {});
}

function renderRename(on) {
  renameAutoToggle.checked = on;
  extRenameBlock.classList.toggle('on', on);
}

export async function loadRenameSettings() {
  try {
    const stored = await chrome.storage.local.get(RENAME_SETTINGS_STORAGE_KEY);
    renameSettings = { ...renameSettings, ...(stored[RENAME_SETTINGS_STORAGE_KEY] || {}) };
  } catch (error) {
    // 读取失败用默认设置
  }
  renderRename(renameSettings.autoEnabled === true);
}

renameAutoToggle.addEventListener('change', () => {
  renameSettings.autoEnabled = renameAutoToggle.checked;
  renderRename(renameSettings.autoEnabled);
  saveRenameSettings();
});
