/**
 * 缓存提醒的纯规则（无 DOM、无事件）：阈值、阶段、时间格式。
 *
 * 阈值是经验值，不是客户端能读到的真实 TTL：
 * - 公开 API 的上下文缓存 TTL 只有 5m / 1h 两档，但 Kimi Code 的实际命中
 *   在本机数据里到 26–30 分钟仍有 67–100% 的高命中，30 分钟后明显掉。
 * - 因此侧栏 25 分钟开始标黄，宠物只在 29–30 分钟提醒，随后恢复常规外观；
 *   文案带「预估」，不当成精确倒计时，也不判断是否已过期。
 *
 * 单独成模块是为了能在 Node 里直接测（cache-hint.js 会拉进 DOM/宠物模块）。
 */

export const CACHE_SIDEBAR_WARN_MINUTES = 25;
export const CACHE_PET_WARN_MS = 29 * 60_000;
export const CACHE_WARN_END_MS = 30 * 60_000;

/** 距最后一次模型请求的毫秒数 → 'idle' | 'warn' */
export function cacheStageFor(elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return 'idle';
  return elapsedMs >= CACHE_PET_WARN_MS && elapsedMs < CACHE_WARN_END_MS ? 'warn' : 'idle';
}

/** 侧栏相对时间只在 25–29 分钟标黄 */
export function shouldWarnSidebarIdle(minutes) {
  return Number.isInteger(minutes)
    && minutes >= CACHE_SIDEBAR_WARN_MINUTES
    && minutes < CACHE_WARN_END_MS / 60_000;
}

/** 倒计时：mm:ss（向上取整到秒，最后一秒显示 0:01 而不是 0:00） */
export function formatCacheRemaining(ms) {
  const totalSec = Math.max(0, Math.ceil(Number(ms) / 1000));
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** 会话列表的相对时间文本 → 空闲分钟数：27m / 28 分钟 / 29分钟前 → 27/28/29；1h/刚刚 → null */
export function parseIdleMinutes(text) {
  const m = String(text || '').trim().match(/(\d+)\s*(?:minutes?|min|m|分钟|分)(?:前|\s*ago)?$/i);
  return m ? Number(m[1]) : null;
}
