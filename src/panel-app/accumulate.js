/**
 * 补丁（桌面端注入）模式的按天用量自积累：无 App 看门狗时的长期统计兜底。
 *
 * turn.step.completed 携带的增量用量按天攒进 localStorage；安装器写的
 * usageDaily（wire.jsonl 全量扫描）到达时按天取大合并——文件是全量真值
 * 但只覆盖到扫描那一刻，积累值补它之后的缺口。
 *
 * 桶口径必须与文件扫描完全一致（metrics.addUsageToBucket：input 记全部输入
 * ＝非缓存 + 缓存读 + 缓存创建），否则「按天取大」是拿两种口径互相压制：
 * 积累侧少算缓存时永远被文件侧顶掉，今日增量与缓存命中率都会失真。
 *
 * 格式版本与兼容约定（与扩展侧 cli-usage.js 的 INDEX_VERSION 同构）：
 * 桶结构或口径一变就把 BUCKET_VERSION 加一，只处置上一版、随即删除旧键，
 * 不做多版本兼容链。扩展侧对应的动作是 bump INDEX_VERSION 让索引整体作废
 * 重扫——那边真值在 wire.jsonl 可重建；这边的积累是页内实时增量、不可重建，
 * 所以选择一次性搬迁而不是丢弃。
 */

import { addUsageToBucket, emptyUsageBucket, normalizeUsage, totalInputTokens } from '../metrics.js';

const BUCKET_VERSION = 2;
const STORAGE_KEY = `kcm.daily.v${BUCKET_VERSION}`;
// v1 的 input 只记非缓存输入（口径与文件扫描不一致，且未记缓存创建），
// 只在 v2 键缺席时读一次，搬迁后连旧键一起删掉；v1 之外不新增兼容分支。
const LEGACY_STORAGE_KEY = `kcm.daily.v${BUCKET_VERSION - 1}`;
const MAX_DAYS = 90;
const WRITE_DEBOUNCE_MS = 2_000;

let mem = null; // 懒加载的内存缓存
let writeTimer = null;

function todayKey(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function storage() {
  try {
    return globalThis.localStorage || null;
  } catch (error) {
    return null;
  }
}

/** v1 桶 → v2 桶：把 cacheRead 并进 input（v2 的 input 是全部输入） */
function migrateV1(legacy) {
  const next = {};
  for (const [day, record] of Object.entries(legacy || {})) {
    if (!record || typeof record !== 'object') continue;
    const cacheRead = Number(record.cacheRead) || 0;
    next[day] = {
      input: (Number(record.input) || 0) + cacheRead,
      output: Number(record.output) || 0,
      cacheRead
    };
  }
  return next;
}

function load() {
  if (mem) return mem;
  mem = {};
  const s = storage();
  if (!s) return mem;
  try {
    const parsed = JSON.parse(s.getItem(STORAGE_KEY) || 'null');
    if (parsed && typeof parsed === 'object') {
      mem = parsed;
      return mem;
    }
  } catch (error) {
    // 解析失败按无积累处理，下面再试迁移
  }
  try {
    const legacy = JSON.parse(s.getItem(LEGACY_STORAGE_KEY) || 'null');
    if (legacy && typeof legacy === 'object') {
      mem = migrateV1(legacy);
      scheduleWrite(); // 迁移结果落盘，旧键在写入成功后清掉
    }
  } catch (error) {
    mem = {};
  }
  return mem;
}

function scheduleWrite() {
  if (writeTimer || !storage()) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const s = storage();
    if (!s) return;
    try {
      s.setItem(STORAGE_KEY, JSON.stringify(mem || {}));
      s.removeItem?.(LEGACY_STORAGE_KEY);
    } catch (error) {
      // 写不进（满/禁用）就只留内存态，面板行为不中断
    }
  }, WRITE_DEBOUNCE_MS);
}

/** 丢弃内存缓存，下次访问重新读存储（外部清空存储后同步 / 测试隔离用） */
export function resetAccumulatedCache() {
  mem = null;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = null;
}

/** turn.step.completed 的增量用量入今日桶（口径见文件头：input 记全部输入） */
export function noteStepUsage(usage) {
  const normalized = normalizeUsage(usage);
  if (!totalInputTokens(normalized) && !normalized.outputTokens) return;
  const map = load();
  const key = todayKey();
  addUsageToBucket(map[key] || (map[key] = emptyUsageBucket()), normalized);
  // 裁剪过旧天数
  const keys = Object.keys(map).sort();
  while (keys.length > MAX_DAYS) delete map[keys.shift()];
  scheduleWrite();
}

/**
 * 按天取大合并：文件（wire.jsonl 全量扫描）与页内积累谁大用谁。
 * 文件含 CLI 等全部本地会话但只到上次扫描时刻；积累只含桌面端会话但实时。
 * 取大消除双算，同时各补各的缺口（两侧同口径，比较才有意义）。
 */
export function mergeDaily(fileDaily) {
  const out = {};
  for (const [day, rec] of Object.entries(fileDaily || {})) {
    if (rec && typeof rec === 'object') out[day] = { ...rec };
  }
  for (const [day, rec] of Object.entries(load())) {
    const cur = out[day];
    const accInput = Number(rec?.input) || 0;
    const curInput = Number(cur?.input) || 0;
    if (!cur || accInput > curInput) {
      // 三个已知字段强制成数字：手改坏存储时不至于把 NaN/字符串带进图表
      out[day] = {
        ...emptyUsageBucket(),
        ...rec,
        input: accInput,
        output: Number(rec?.output) || 0,
        cacheRead: Number(rec?.cacheRead) || 0
      };
    }
  }
  return out;
}

/** 页内是否已攒到任何数据 */
export function hasAccumulated() {
  return Object.keys(load()).length > 0;
}
