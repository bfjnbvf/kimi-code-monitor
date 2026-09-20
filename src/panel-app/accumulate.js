/**
 * 补丁（桌面端注入）模式的按天用量自积累：无 App 看门狗时的长期统计兜底。
 *
 * turn.step.completed 携带的增量用量按天攒进 localStorage；App 看门狗写的
 * usageDaily（wire.jsonl 全量扫描）到达时按天取大合并——文件是全量真值
 * 但只覆盖到看门狗最后一次运行，积累值补它之后的缺口。
 * 数据形状对齐 usageDaily 的日记录：{ input, output, cacheRead }。
 */

const STORAGE_KEY = 'vibepal.daily.v1';
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

function load() {
  if (mem) return mem;
  mem = {};
  const s = storage();
  if (!s) return mem;
  try {
    const parsed = JSON.parse(s.getItem(STORAGE_KEY) || 'null');
    if (parsed && typeof parsed === 'object') mem = parsed;
  } catch (error) {
    mem = {};
  }
  return mem;
}

function scheduleWrite() {
  if (writeTimer || !storage()) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      storage()?.setItem(STORAGE_KEY, JSON.stringify(mem || {}));
    } catch (error) {
      // 写不进（满/禁用）就只留内存态，面板行为不中断
    }
  }, WRITE_DEBOUNCE_MS);
}

/** turn.step.completed 的增量用量入今日桶 */
export function noteStepUsage(usage) {
  if (!usage) return;
  const input = Number(usage.inputTokens) || 0;
  const output = Number(usage.outputTokens) || 0;
  const cacheRead = Number(usage.cacheReadTokens) || 0;
  if (!input && !output && !cacheRead) return;
  const map = load();
  const key = todayKey();
  const day = map[key] || (map[key] = { input: 0, output: 0, cacheRead: 0 });
  day.input += input;
  day.output += output;
  day.cacheRead += cacheRead;
  // 裁剪过旧天数
  const keys = Object.keys(map).sort();
  while (keys.length > MAX_DAYS) delete map[keys.shift()];
  scheduleWrite();
}

/**
 * 按天取大合并：文件（wire.jsonl 全量扫描）与页内积累谁大用谁。
 * 文件含 CLI 等全部本地会话但只到看门狗最后运行时刻；积累只含桌面端会话
 * 但实时。取大消除双算，同时各补各的缺口。
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
      out[day] = {
        input: Number(rec.input) || 0,
        output: Number(rec.output) || 0,
        cacheRead: Number(rec.cacheRead) || 0
      };
    }
  }
  return out;
}

/** 页内是否已攒到任何数据 */
export function hasAccumulated() {
  return Object.keys(load()).length > 0;
}
