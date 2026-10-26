/**
 * 静态注入的站点范围（与 manifest.json / rules/csp_relax.json 保持一致）。
 *
 * 回环只静态覆盖 kimi web 的默认端口：Chrome 的 match pattern 支持端口精确匹配，
 * 写端口就只匹配该端口，不写才等同全端口通配。其他端口一律走 popup 的
 * 「在此站点启用」动态授权（src/background/dynamic-hosts.js），未授权的本机
 * 页面拿不到内容脚本，也就读不到面板与收藏。
 *
 * 改端口时三处同步：本文件、manifest.json 的 content_scripts/host_permissions、
 * rules/csp_relax.json 的 urlFilter。
 */

export const DEFAULT_WEB_PORT = 58627;

export const STATIC_URL_PATTERNS = [
  `http://127.0.0.1:${DEFAULT_WEB_PORT}/*`,
  `http://localhost:${DEFAULT_WEB_PORT}/*`,
  'https://code-rc.kimi.com/*'
];

export function originPatternOf(url) {
  return `${url.protocol}//${url.host}/*`;
}

export function isStaticOrigin(value) {
  let url;
  try {
    url = value instanceof URL ? value : new URL(String(value || ''));
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return STATIC_URL_PATTERNS.includes(originPatternOf(url));
}
