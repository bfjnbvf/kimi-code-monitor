/**
 * 消息来源守卫：后台特权 handler 的纵深防御。
 *
 * 能到达 onMessage 的发送者有三类：
 * - 扩展自有页面：popup（sender 无 tab）与选项页/其他扩展标签页（sender 带
 *   tab），URL 均为 chrome-extension://<自身 id>/ 前缀——全量放行；
 * - 内容脚本：sender.url 是宿主页面 URL（http/https），仅「回环 + 已动态授权
 *   origin」的来源，且消息类型属于内容脚本实际使用的白名单；
 * - 网页/其他扩展：未配置 externally_connectable，到不了这里（防御性拒绝）。
 *
 * 注意不能用「有没有 tab」区分扩展页面与内容脚本——选项页以标签页打开时
 * sender 同样带 tab，必须按 URL 前缀判定。内容侧新增 sendMessage 调用点时
 * 同步维护白名单。
 */

import { isAuthorizedContentUrl } from './dynamic-hosts.js';

// 内容脚本会发送的全部消息类型（与 src/content.js、src/content/ 的
// chrome.runtime.sendMessage 调用点一一对应；v3.4.0 起命名走系统「生成标题」，
// rename.model 已随旧管线移出白名单）。
const CONTENT_MESSAGE_TYPES = new Set([
  'quota.fetch',
  'oauth.start',
  'cli.usage.status',
  'cli.usage.refresh',
  'cli.usage.open_settings',
  'external.status',
  'pet.asset.active',
  // web-token.js 当前未注册、保留备用：重新启用时它注入 www.kimi.com，
  // 需同时把该 origin 纳入 isAuthorizedContentUrl 的放行集合
  'webtoken.report'
]);

export async function authorizeMessage(type, sender) {
  const url = String(sender?.url || '');
  // 扩展自有页面（popup / 选项页标签）：按自身扩展 ID 的 URL 前缀识别
  const ownPrefix = `chrome-extension://${chrome.runtime.id}/`;
  if (url.startsWith(ownPrefix)) return true;
  // 其余无 tab 的发送者视为扩展上下文（防御性放行，正常路径不会出现）
  if (!sender?.tab) return true;
  // 内容脚本：来源必须是本机回环或已动态授权的站点，且消息类型在白名单内
  if (!CONTENT_MESSAGE_TYPES.has(type)) return false;
  return isAuthorizedContentUrl(sender.url);
}
