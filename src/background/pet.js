/**
 * 桌面宠物域：content script 读不到扩展 IndexedDB，当前宠物图集经这里中转。
 */

import * as CodexPetStore from '../pet/store.js';

// 当前桌面宠物的图集：content script 读不到扩展的 IndexedDB，由这里中转。
// 顺带触发旧版单宠物存储的一次性迁移（幂等）。
export async function getActivePetAsset() {
  try {
    await CodexPetStore.ensureMigrated();
    const stored = await chrome.storage.local.get(CodexPetStore.ACTIVE_ID_KEY);
    const activeId = stored[CodexPetStore.ACTIVE_ID_KEY];
    if (!activeId) return { ok: true, dataUrl: null };
    const record = await CodexPetStore.get(activeId);
    return { ok: true, dataUrl: record?.dataUrl || null };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

