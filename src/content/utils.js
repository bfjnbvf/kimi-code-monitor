/**
 * 通用小工具：纯函数，不依赖 DOM / chrome API。
 * content / render / websocket-session / pet 各域共用。
 */

// 外部 API / CLI 扫描来源的字符串进 innerHTML 前统一转义（title 属性插值单层即可）
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[ch]);
}

export function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '--';
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function progressClass(percentage) {
  if (percentage >= 80) return 'ksb-high';
  if (percentage >= 50) return 'ksb-mid';
  return 'ksb-low';
}

// 面板状态文案：渲染层（状态灯/状态字）与宠物域（宠物状态、时钟切行）共用
export const STATUS_TEXT = {
  idle: '空闲',
  thinking: '思考中',
  executing: '调用中',
  replying: '回复中',
  offline: '未连接',
  unauthorized: '未授权',
  ratelimit: '限流中',
  subagent: '子代理'
};


// 一轮回答的组成状态：思考↔回复↔调用↔子代理↔限流之间切换属于同一轮回答（连续计时不打断）
export const PET_ANSWER_STATUSES = ['thinking', 'executing', 'replying', 'subagent', 'ratelimit'];

export const CONSOLE_URL = 'https://www.kimi.com/code/console';
export const SUBSCRIPTION_URL = 'https://www.kimi.com/membership/subscription?tab=quota';

export function parseResetTime(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : null;
}
