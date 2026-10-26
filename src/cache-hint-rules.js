/**
 * 缓存提醒的纯规则（无 DOM、无事件）：阈值、阶段、时间格式。
 *
 * 阈值是经验值，不是客户端能读到的真实 TTL：
 * - 公开 API 的上下文缓存 TTL 只有 5m / 1h 两档，但 Kimi Code 的实际命中
 *   在本机数据里到 26–30 分钟仍有 67–100% 的高命中，30 分钟后明显掉。
 * - 因此 27 分钟提醒、30 分钟判「可能过期」，文案带「预估/可能」，不当成精确倒计时。
 *
 * 单独成模块是为了能在 Node 里直接测（cache-hint.js 会拉进 DOM/宠物模块）。
 */

export const CACHE_WARN_MS = 27 * 60_000;
export const CACHE_COLD_MS = 30 * 60_000;

/** 距最后一次模型请求的毫秒数 → 'idle' | 'warn' | 'cold' */
export function cacheStageFor(elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return 'idle';
  if (elapsedMs >= CACHE_COLD_MS) return 'cold';
  if (elapsedMs >= CACHE_WARN_MS) return 'warn';
  return 'idle';
}

/** 倒计时：mm:ss（向上取整到秒，最后一秒显示 0:01 而不是 0:00） */
export function formatCacheRemaining(ms) {
  const totalSec = Math.max(0, Math.ceil(Number(ms) / 1000));
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** 闲置分钟数（向下取整） */
export function formatCacheIdleMinutes(ms) {
  return Math.max(0, Math.floor(Number(ms) / 60_000));
}
