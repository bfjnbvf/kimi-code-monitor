/**
 * kap-server 本机访问的鉴权（技能脚本专用，Node ≥16）。
 *
 * 桌面客户端 2.x 起所有 /api/v1/* 都要求 Bearer 令牌，裸调返回
 * `{"code":40101,"msg":"Unauthorized"}`。令牌由主进程每次启动生成，落盘在
 * `~/.kimi-code/server.token`（KIMI_CODE_HOME 可改根目录），与页面 URL hash
 * 下发给 SPA 的是同一套校验（启动密钥 + 文件令牌二选一，见客户端
 * createDesktopAuthTokenService）。
 *
 * 面板（注入页面的 JS）**不需要**这个模块——主进程的 webRequest 钩子给页面
 * 发往 kap 的请求自动注入 Authorization 头，WS 升级同样覆盖（升级处理器接受
 * 「Authorization 头」或「kimi-code.bearer.<token> 子协议」二选一）。只有独立
 * 进程跑的脚本（技能三件套：client-providers / doctor）必须自己带令牌。
 *
 * 读不到文件时返回空：老客户端无鉴权，裸调即可（向后兼容）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** server.token 文件内容；缺失/读失败/空文件返回空串 */
export function kapToken(home = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code')) {
  try {
    return fs
      .readFileSync(
        path.join(home, 'server.token'),
        'utf8'
      )
      .trim();
  } catch (error) {
    return '';
  }
}

/** kap 请求用的鉴权头；无令牌时返回空对象（老客户端裸调，向后兼容） */
export function kapAuthHeaders(home) {
  const token = kapToken(home);
  return token ? { Authorization: `Bearer ${token}` } : {};
}
