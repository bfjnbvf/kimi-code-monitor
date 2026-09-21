#!/usr/bin/env node
/**
 * Kimi Code 桌面端监控面板补丁 · 安装器（跨平台：macOS / Windows，Node ≥16）
 *
 * 用法：
 *   node install.mjs               安装/更新补丁（幂等，可反复执行）
 *   node install.mjs --uninstall   完整卸载（还原 index.html、删除补丁目录）
 *   node install.mjs --app <路径>  指定客户端位置（也接受裸路径参数）
 *
 * 平台关系：同一个脚本，平台差异只收敛在「平台差异区」的三个纯函数
 * （appRootCandidates / distDirOf / readClientVersion），公共流程零分支。
 * 旧版 bash 安装器（install.sh）过渡期内随包保留，行为与本文件一致。
 *
 * 行为：
 *   1. 备份 desktop-dist/index.html 为 index.html.bak-kcm（仅在备份
 *      不存在时创建，重装永远保留最早的原始版本）
 *   2. 把补丁包里的 kcm/ 目录整体同步进 desktop-dist/（fetch-wallet.mjs
 *      若在包内，一并进驻载荷）
 *   3. 有 sessions 目录时全量扫描 ~/.kimi-code/sessions 生成 usage-daily.js
 *      （历史统计预填；KIMI_CODE_HOME 可改根目录）；没有则跳过
 *   4. 有本机凭据时抓加油包余额快照 wallet.js（尽力而为，失败只降级余额显示）
 *   5. 在 index.html 的 </head> 前注入 <script src="/kcm/loader.js?v=哈希">
 *      （哈希取自载荷内容，客户端更新缓存自动失效）
 *
 * 客户端自动更新会整体替换 desktop-dist（补丁随之消失，属预期）：
 * 重新执行本脚本即可重装，历史统计会重新扫描补齐，页内积累的数据
 * 存在客户端用户数据里，不受更新影响。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_NAME = 'Kimi Code';
const LOADER_SRC = '/kcm/loader.js';
const PAYLOAD_DIR = 'kcm';
const BACKUP_SUFFIX = '.bak-kcm';
// 机器数据 / 工具文件不进载荷哈希（与 install.sh 的排除项保持一致）：
// usage-daily/external 是扫描与代查产物，wallet 是余额快照，fetch-wallet 是工具本体
const EXCLUDED_FROM_HASH = new Set(['usage-daily.js', 'external.js', 'wallet.js', 'fetch-wallet.mjs']);

/* ---------- 平台差异区（仅此区读 process.platform / env） ---------- */

/** 客户端安装根目录候选（按序）。env/home/platform 可注入，便于测试。
 *  路径拼接用 path.win32/posix 显式对应平台——纯函数不随宿主平台漂移。 */
export function appRootCandidates(env = process.env, home = os.homedir(), platform = process.platform) {
  const out = [];
  if (env.KIMI_CODE_APP_DIR) out.push(env.KIMI_CODE_APP_DIR);
  if (platform === 'win32') {
    // electron-builder NSIS 默认按用户安装；另照顾自定义位置（参考项目的 D 盘装法）
    if (env.LOCALAPPDATA) out.push(path.win32.join(env.LOCALAPPDATA, 'Programs', APP_NAME));
    out.push(path.win32.join('C:\\Program Files', APP_NAME));
    out.push(path.win32.join('D:\\kimi_code', APP_NAME));
  } else {
    out.push(path.posix.join('/Applications', `${APP_NAME}.app`));
    out.push(path.posix.join(home, 'Applications', `${APP_NAME}.app`));
  }
  return out;
}

/** 应用根 → desktop-dist 目录。传入路径本身就是 desktop-dist 时直接用。 */
export function distDirOf(appRoot, platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (p.basename(appRoot) === 'desktop-dist') return appRoot;
  return platform === 'win32'
    ? p.join(appRoot, 'resources', 'desktop-dist')
    : p.join(appRoot, 'Contents', 'Resources', 'desktop-dist');
}

/** 客户端版本（仅信息展示，取不到返回 '?'，不阻断安装）。 */
export function readClientVersion(appRoot, platform = process.platform) {
  try {
    if (platform === 'darwin') {
      const plist = fs.readFileSync(path.join(appRoot, 'Contents', 'Info.plist'), 'utf8');
      const m = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
      return m ? m[1] : '?';
    }
    if (platform === 'win32') {
      // electron-builder：exe 在安装根目录，与 resources/ 并列
      const exe = fs.readdirSync(appRoot).find((f) => f.toLowerCase().endsWith('.exe'));
      if (!exe) return '?';
      const exePath = path.join(appRoot, exe).replace(/'/g, "''");
      const out = execFileSync(
        'powershell',
        ['-NoProfile', '-Command', `(Get-Item '${exePath}').VersionInfo.ProductVersion`],
        { timeout: 8000, windowsHide: true }
      );
      return String(out).trim() || '?';
    }
  } catch (error) {
    // 版本读取失败不影响安装
  }
  return '?';
}

function reloadKey(platform = process.platform) {
  return platform === 'win32' ? 'Ctrl+R' : 'Cmd+R';
}

/* ---------- 公共流程（零平台分支） ---------- */

function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirSync(from, to);
    else fs.copyFileSync(from, to); // 载荷内无符号链接；万一有，复制指向内容
  }
}

/** 载荷内容哈希：与旧 bash 管线（find|shasum|sort|shasum）逐字节兼容，
 *  排除机器数据文件（usage-daily.js / external.js）。 */
export function payloadHash(root) {
  const files = [];
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relPath);
      else if (!EXCLUDED_FROM_HASH.has(entry.name)) files.push(relPath);
    }
  };
  walk(root, '');
  const lines = files
    .map((rel) => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex')}  ./${rel}`)
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const text = lines.map((line) => `${line}\n`).join('');
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 8);
}

/** 去掉所有含 loader 标签的行（幂等重装 / 无备份卸载用）。 */
/** 去掉所有含 loader 标签的行（幂等重装 / 无备份卸载用） */
export function stripLoaderTagLines(html) {
  return html.split('\n').filter((line) => !line.includes(LOADER_SRC)).join('\n');
}

/** 在首个 </head> 前插入 loader 标签；找不到返回 null。 */
export function injectLoaderTag(html, hash) {
  const marker = '</head>';
  const idx = html.indexOf(marker);
  if (idx < 0) return null;
  const tag = `      <script src="${LOADER_SRC}?v=${hash}"></script>\n`;
  return html.slice(0, idx) + tag + html.slice(idx);
}

function kimiHome() {
  return process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
}

function sessionsDir() {
  return path.join(kimiHome(), 'sessions');
}

/** 历史统计预填：跑 scan.mjs 生成 usage-daily.js。失败不阻断安装。 */
function prescanHistory(dist) {
  const scanMjs = path.join(HERE, 'scan.mjs');
  const sessions = sessionsDir();
  if (!fs.existsSync(scanMjs)) {
    console.error('[install] 跳过历史预填（补丁包缺 scan.mjs），面板从安装时刻开始积累');
    return;
  }
  if (!fs.existsSync(sessions)) {
    console.error('[install] 跳过历史预填（无 sessions 目录），面板从安装时刻开始积累');
    return;
  }
  const out = path.join(dist, PAYLOAD_DIR, 'usage-daily.js');
  try {
    execFileSync(process.execPath, [scanMjs, '--sessions', sessions, '--out', out], { stdio: 'inherit' });
    if (!fs.existsSync(out) || fs.statSync(out).size === 0) throw new Error('输出为空');
    console.error('[install] 历史统计已预填');
  } catch (error) {
    fs.rmSync(out, { force: true });
    console.error('[install] 历史预填未生效（不影响安装，面板从安装时刻开始积累）');
  }
}

/** 加油包余额快照：跑 fetch-wallet.mjs 生成 wallet.js。尽力而为，失败只降级余额显示。 */
function fetchWalletSnapshot(dist) {
  const tool = path.join(HERE, 'fetch-wallet.mjs');
  const credentials = path.join(kimiHome(), 'credentials', 'kimi-code.json');
  if (!fs.existsSync(tool) || !fs.existsSync(credentials)) return;
  const out = path.join(dist, PAYLOAD_DIR, 'wallet.js');
  try {
    execFileSync(process.execPath, [tool, '--out', out], { stdio: 'inherit' });
    if (!fs.existsSync(out) || fs.statSync(out).size === 0) throw new Error('输出为空');
    console.error('[install] 余额快照已获取');
  } catch (error) {
    fs.rmSync(out, { force: true });
    console.error('[install] 余额快照未生效（不影响安装，可稍后用技能刷新）');
  }
}

function install(appRoot, dist) {
  if (!fs.existsSync(path.join(HERE, PAYLOAD_DIR, 'loader.js'))) {
    console.error(`[install] 补丁载荷不完整：缺 ${PAYLOAD_DIR}/loader.js（请确认解压了完整补丁包）`);
    process.exit(1);
  }
  const index = path.join(dist, 'index.html');
  if (!fs.existsSync(index)) {
    console.error(`[install] 未找到 ${index}——请确认 --app 指向的是客户端安装目录`);
    process.exit(1);
  }

  const backup = index + BACKUP_SUFFIX;
  if (!fs.existsSync(backup)) {
    fs.copyFileSync(index, backup);
    console.error('[install] 已备份原始 index.html');
  } else {
    console.error('[install] 备份已存在，保留最早的原始版本');
  }

  fs.rmSync(path.join(dist, PAYLOAD_DIR), { recursive: true, force: true });
  copyDirSync(path.join(HERE, PAYLOAD_DIR), path.join(dist, PAYLOAD_DIR));
  // 余额抓取工具随载荷进驻补丁目录（技能后续「刷新余额」直接运行它）
  const walletTool = path.join(HERE, 'fetch-wallet.mjs');
  if (fs.existsSync(walletTool)) {
    fs.copyFileSync(walletTool, path.join(dist, PAYLOAD_DIR, 'fetch-wallet.mjs'));
  }
  console.error('[install] 载荷已同步');

  prescanHistory(dist);
  fetchWalletSnapshot(dist);

  const hash = payloadHash(path.join(dist, PAYLOAD_DIR));
  const html = fs.readFileSync(index, 'utf8');
  const injected = injectLoaderTag(stripLoaderTagLines(html), hash);
  if (injected === null) {
    console.error('[install] 注入标签失败：index.html 结构与预期不符（可能客户端大版本更新），已中止');
    fs.copyFileSync(backup, index);
    fs.rmSync(path.join(dist, PAYLOAD_DIR), { recursive: true, force: true });
    process.exit(1);
  }
  fs.writeFileSync(index, injected);
  if (!fs.readFileSync(index, 'utf8').includes(`${LOADER_SRC}?v=${hash}`)) {
    console.error('[install] 注入校验失败，正在还原备份……');
    fs.copyFileSync(backup, index);
    fs.rmSync(path.join(dist, PAYLOAD_DIR), { recursive: true, force: true });
    process.exit(1);
  }

  console.error(`[install] 完成（载荷 v=${hash}）`);
  console.error(`[install] 请重载 Kimi Code 客户端（${reloadKey()}）或重启客户端，面板将出现在会话侧栏底部`);
}

function uninstall(dist) {
  const index = path.join(dist, 'index.html');
  const backup = index + BACKUP_SUFFIX;
  if (fs.existsSync(backup)) {
    fs.copyFileSync(backup, index);
    fs.rmSync(backup);
    console.error('[install] 已还原原始 index.html');
  } else if (fs.existsSync(index)) {
    fs.writeFileSync(index, stripLoaderTagLines(fs.readFileSync(index, 'utf8')));
    console.error('[install] 未找到备份，已移除注入行');
  }
  fs.rmSync(path.join(dist, PAYLOAD_DIR), { recursive: true, force: true });
  console.error('[install] 补丁目录已删除，卸载完成（重载客户端生效）');
  console.error('[install] 注：面板写在页面 localStorage 的少量键（布局配置/按天积累）保留在客户端用户数据里，不影响运行；重装时会按新语义继续使用');
}

function main() {
  const args = process.argv.slice(2);
  let action = 'install';
  let appArg = '';
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--uninstall') action = 'uninstall';
    else if (arg === '--app') appArg = args[(i += 1)] || '';
    else if (arg.startsWith('--app=')) appArg = arg.slice('--app='.length);
    else if (!arg.startsWith('-')) appArg = arg; // 裸路径（兼容 bash 版用法）
  }

  let appRoot = appArg ? path.resolve(appArg) : null;
  if (!appRoot) {
    appRoot = appRootCandidates().find((c) => fs.existsSync(path.join(distDirOf(c), 'index.html'))) || null;
  }
  if (!appRoot) {
    console.error('[install] 未找到 Kimi Code 桌面客户端（需要含 desktop-dist 的应用包）');
    console.error('[install] 若客户端装在其他位置：node install.mjs --app <客户端目录>，或设环境变量 KIMI_CODE_APP_DIR');
    process.exit(1);
  }
  const dist = distDirOf(appRoot);
  console.error(`[install] 客户端：${appRoot}`);
  if (action === 'uninstall') uninstall(dist);
  else install(appRoot, dist);
}

// 直接执行时跑 CLI（被 import 时不跑；esbuild 打包后依然成立）。
// 必须先 realpath：macOS 的 /tmp 是 /private/tmp 的符号链接，Node 会把主模块
// 解析成真实路径写进 import.meta.url，argv[1] 却保留调用时的符号链接路径，
// 不对齐的话经符号链接调用（智能体常在 /tmp 解压执行）会静默不执行 main。
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main();
}
