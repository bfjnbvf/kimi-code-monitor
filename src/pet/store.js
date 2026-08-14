/* Codex Pet 素材库：IndexedDB 存储（扩展源，popup 与 background 共享）。
 *
 * 为什么不用 chrome.storage.local：单只宠物图集 base64 约 3MB，
 * storage.local 总配额 10MB，存三只就会爆；IndexedDB 没有这个量级限制。
 * chrome.storage.local 里只存小状态：当前宠物 id（kimi-statusbar.petActiveId）。
 *
 * 记录结构：{ id, name, author, source, dataUrl, addedAt }
 * 经典脚本，popup 用 <script>、background 用 importScripts 加载，
 * 全局暴露 CodexPetStore。
 */
'use strict';

// 独立库名：不与 cli-usage.js 的 'kimi-code-monitor' 共用，避免版本升级互相干扰
const DB_NAME = 'kimi-code-monitor-pets';
const STORE = 'pets';

// 早期版本存放素材的位置（迁移来源；只读，不动旧库）
const LEGACY_DB_NAME = 'kimi-code-monitor';

// 早期版本的单宠物 storage 键（迁移来源）
const LEGACY_DATA_KEY = 'kimi-statusbar.petData';
const LEGACY_INFO_KEY = 'kimi-statusbar.petInfo';
const ACTIVE_ID_KEY = 'kimi-statusbar.petActiveId';
const READY_KEY = 'kimi-statusbar.petStoreReady'; // 一次性清理完成标记

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    // 不显式指定版本：已存在的库按其当前版本打开（写死低版本会因 VersionError 打不开），
    // 不存在时以 1 创建并触发 onupgradeneeded
    const req = indexedDB.open(DB_NAME);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      if (db.objectStoreNames.contains(STORE)) {
        resolve(db);
        return;
      }
      // 库已存在但缺 pets store 时，升一级补建（onupgradeneeded 只在升版本时触发）
      db.close();
      const req2 = indexedDB.open(DB_NAME, db.version + 1);
      req2.onupgradeneeded = () => {
        if (!req2.result.objectStoreNames.contains(STORE)) {
          req2.result.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req2.onsuccess = () => resolve(req2.result);
      req2.onerror = () => reject(req2.error || new Error('IndexedDB 升级失败'));
    };
    req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
  });
  return dbPromise;
}

function asRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 请求失败'));
  });
}

/** 列出全部宠物（不含图集本体，按安装时间正序） */
async function list() {
  const db = await openDb();
  const records = await asRequest(db.transaction(STORE, 'readonly').objectStore(STORE).getAll());
  return (records || [])
    .map(({ id, name, author, source, addedAt }) => ({ id, name, author, source, addedAt }))
    .sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
}

async function listAll() {
  const db = await openDb();
  return asRequest(db.transaction(STORE, 'readonly').objectStore(STORE).getAll());
}

/** 取一只宠物的完整记录（含 dataUrl 图集） */
async function get(id) {
  const db = await openDb();
  return asRequest(db.transaction(STORE, 'readonly').objectStore(STORE).get(id));
}

/** 安装一只新宠物，返回新记录 id */
async function add({ name, author, source, dataUrl }) {
  if (!dataUrl || typeof dataUrl !== 'string') throw new Error('素材为空');
  const record = {
    id: `pet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: name || '未命名',
    author: author || '',
    source: source || '',
    dataUrl,
    addedAt: Date.now()
  };
  const db = await openDb();
  await asRequest(db.transaction(STORE, 'readwrite').objectStore(STORE).put(record));
  return record.id;
}

async function remove(id) {
  const db = await openDb();
  await asRequest(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id));
}

/**
 * 早期版本数据的一次性迁移（幂等，READY_KEY 置位后直接返回）：
 * 1. 旧 storage 单宠物键（petData/petInfo）入库并设为当前；
 * 2. 旧版共享库（'kimi-code-monitor'）里的宠物记录搬回独立库，
 *    并删除旧库里的 pets store（删 store 需升版本号）；
 * 3. 删除全部旧键与旧迁移标记。
 */
async function ensureMigrated() {
  let stored;
  try {
    stored = await chrome.storage.local.get([READY_KEY, LEGACY_DATA_KEY, LEGACY_INFO_KEY, ACTIVE_ID_KEY]);
  } catch (error) {
    return; // storage 不可用时跳过，下次再试
  }
  if (stored[READY_KEY]) return;

  // 1. 旧 storage 单宠物入库（先按 dataUrl 去重，避免崩溃/未置位导致重复素材）
  const legacyData = stored[LEGACY_DATA_KEY];
  const legacyInfo = stored[LEGACY_INFO_KEY];
  if (typeof legacyData === 'string' && legacyData) {
    try {
      const existing = await listAll();
      const duplicate = existing.find((record) => record?.dataUrl === legacyData);
      if (duplicate) {
        if (!stored[ACTIVE_ID_KEY]) {
          await chrome.storage.local.set({ [ACTIVE_ID_KEY]: duplicate.id }).catch(() => {});
        }
      } else {
        const id = await add({
          name: legacyInfo?.name,
          author: legacyInfo?.author,
          source: legacyInfo?.source,
          dataUrl: legacyData
        });
        if (!stored[ACTIVE_ID_KEY]) {
          await chrome.storage.local.set({ [ACTIVE_ID_KEY]: id }).catch(() => {});
        }
      }
    } catch (error) {
      console.warn('[Kimi Pet] 旧 storage 宠物迁移失败', error);
      return; // 迁移失败不置标记，下次重试
    }
  }

  // 2. 旧共享库里的宠物搬回 + 删掉旧 store
  await rescueAndCleanSharedDb();

  // 3. 清掉旧键与旧迁移标记，置完成标记
  await chrome.storage.local.remove([
    LEGACY_DATA_KEY, LEGACY_INFO_KEY,
    'kimi-statusbar.petLibraryMigrated',
    'kimi-statusbar.petLibraryMigratedV2'
  ]).catch(() => {});
  await chrome.storage.local.set({ [READY_KEY]: true }).catch(() => {});
}

async function rescueAndCleanSharedDb() {
  // 先看库存不存在，避免为了检查而凭空创建它
  let dbs = [];
  try {
    dbs = await indexedDB.databases();
  } catch (error) {
    return;
  }
  const legacyInfo = dbs.find((d) => d.name === LEGACY_DB_NAME);
  if (!legacyInfo) return;

  const legacyDb = await new Promise((resolve, reject) => {
    const req = indexedDB.open(LEGACY_DB_NAME); // 不带版本号，只读
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch(() => null);
  if (!legacyDb) return;

  try {
    if (!legacyDb.objectStoreNames.contains(STORE)) return;
    // 搬回记录（保留原 id，按 id 或 dataUrl 去重）
    const records = await asRequest(
      legacyDb.transaction(STORE, 'readonly').objectStore(STORE).getAll()
    );
    const mine = await listAll();
    const mineIds = new Set(mine.map((p) => p.id));
    const mineDataUrls = new Set(mine.map((p) => p.dataUrl).filter(Boolean));
    if (Array.isArray(records) && records.length) {
      const db = await openDb();
      for (const record of records) {
        if (record?.id && record?.dataUrl && !mineIds.has(record.id) && !mineDataUrls.has(record.dataUrl)) {
          await asRequest(db.transaction(STORE, 'readwrite').objectStore(STORE).put(record));
          mineIds.add(record.id);
          mineDataUrls.add(record.dataUrl);
        }
      }
    }
    // 删除旧库里的 pets store（删 store 只能在 upgradeneeded 里做，升一个版本号）
    const nextVersion = legacyDb.version + 1;
    legacyDb.close();
    await new Promise((resolve) => {
      const req = indexedDB.open(LEGACY_DB_NAME, nextVersion);
      req.onupgradeneeded = () => {
        if (req.result.objectStoreNames.contains(STORE)) {
          req.result.deleteObjectStore(STORE);
        }
      };
      req.onsuccess = () => { req.result.close(); resolve(); };
      req.onerror = () => resolve(); // 删不掉也不影响主流程
    });
  } catch (error) {
    legacyDb.close();
    console.warn('[Kimi Pet] 旧共享库清理失败', error);
    // 搬移/清理失败不影响主流程
  }
}

const CodexPetStore = {
  list,
  get,
  add,
  remove,
  ensureMigrated,
  ACTIVE_ID_KEY
};

export {
  list,
  get,
  add,
  remove,
  ensureMigrated,
  ACTIVE_ID_KEY,
  CodexPetStore
};
