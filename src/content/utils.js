/**
 * 通用小工具：纯函数为主，仅 rcApiPrefix 等 RC 适配读取 location。
 * content / render / websocket-session / pet 各域共用。
 */

/**
 * 只接受真实用户手势。页面脚本的 element.click() / dispatchEvent 产生的事件
 * isTrusted 为 false；面板里的授权、刷新、跳转、收藏都靠这一层挡住合成点击。
 * 键盘触发（Enter/空格）是可信事件，不受影响。
 */
export function isUserGesture(event) {
  return event?.isTrusted === true;
}

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

// 面板状态文案（键 → 中文原文，i18n 的 t() 以原文为键查英文表）
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

// 「点击跳转」的唯一出口：标题行的数据位与宠物模块的小球共用这一份逻辑
// （配置值 dataLink：none 不跳 / console 控制台 / subscription 充值页）。
// 之前两处各写一遍 if/else，改动容易漏一边——统一到这里。
export function openDataLink(link) {
  if (link === 'console') window.open(CONSOLE_URL, '_blank');
  else if (link === 'subscription') window.open(SUBSCRIPTION_URL, '_blank');
}

/* ---------- Remote Control（kimi rc）适配 ----------
 * RC 页面挂在云端中继（code-rc.kimi.com）的 /devices/<id>/ 前缀下，
 * REST/WS 必须带此前缀才会被路由回本机服务器；本机/LAN 直连时为空串。
 * RC 由云端鉴权、回源时注入本机 token，页面 localStorage 里没有凭据，
 * 因此空凭据时应省略 Authorization 头 / WS 子协议（与中继自带的 web UI 一致）。 */
export function rcApiPrefix() {
  return location.pathname.match(/^\/devices\/[^/?#]+/)?.[0] || '';
}

export function isRemoteControl() {
  return rcApiPrefix() !== '';
}

export function localApiAuthHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function parseResetTime(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : null;
}
