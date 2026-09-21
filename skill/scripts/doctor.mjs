#!/usr/bin/env node
/**
 * KCM 面板外部级自检（跨平台：macOS / Windows，Node ≥16）。
 * 只读检查，不改任何文件。输出 PASS/FAIL/WARN 逐项结论 + 建议动作，
 * 供 Agent（技能 doctor.md）解读。平台差异只集中在应用发现与版本读取两个函数。
 *
 * 用法：node doctor.mjs [--app <客户端目录>]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP_NAME = 'Kimi Code';
const BACKUP_SUFFIX = '.bak-kcm';
const LOADER_SRC = '/kcm/loader.js';
const EXCLUDED_FROM_HASH = new Set(['usage-daily.js', 'external.js', 'wallet.js', 'fetch-wallet.mjs']);

/* ---------- 平台差异 ---------- */

function appRootCandidates() {
  const out = [];
  if (process.env.KIMI_CODE_APP_DIR) out.push(process.env.KIMI_CODE_APP_DIR);
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) out.push(path.win32.join(process.env.LOCALAPPDATA, 'Programs', APP_NAME));
    out.push(path.win32.join('C:\\Program Files', APP_NAME));
    out.push(path.win32.join('D:\\kimi_code', APP_NAME));
  } else {
    out.push(path.posix.join('/Applications', `${APP_NAME}.app`));
    out.push(path.posix.join(os.homedir(), 'Applications', `${APP_NAME}.app`));
  }
  return out;
}

function distDirOf(appRoot) {
  const p = process.platform === 'win32' ? path.win32 : path.posix;
  if (p.basename(appRoot) === 'desktop-dist') return appRoot;
  return process.platform === 'win32'
    ? p.join(appRoot, 'resources', 'desktop-dist')
    : p.join(appRoot, 'Contents', 'Resources', 'desktop-dist');
}

function readClientVersion(appRoot) {
  try {
    if (process.platform === 'darwin') {
      const plist = fs.readFileSync(path.join(appRoot, 'Contents', 'Info.plist'), 'utf8');
      const m = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
      return m ? m[1] : '?';
    }
    if (process.platform === 'win32') {
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
    // 取不到不阻断自检
  }
  return '?';
}

/* ---------- 公共检查 ---------- */

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
    .sort((a, b) => (Buffer.compare(Buffer.from(a), Buffer.from(b))));
  return crypto.createHash('sha256').update(lines.map((l) => `${l}\n`).join('')).digest('hex').slice(0, 8);
}

function httpStatus(port, urlPath, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.on('error', () => resolve(0));
  });
}

function fmtMtime(file) {
  const d = fs.statSync(file).mtime;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ---------- 主流程 ---------- */

async function main() {
  let pass = 0;
  let fail = 0;
  let warn = 0;
  const ok = (msg) => { console.log(`PASS  ${msg}`); pass += 1; };
  const bad = (msg) => { console.log(`FAIL  ${msg}`); fail += 1; };
  const warnFn = (msg) => { console.log(`WARN  ${msg}`); warn += 1; };

  // --app 覆盖（可选）
  let appArg = '';
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--app') appArg = args[(i += 1)] || '';
    else if (args[i].startsWith('--app=')) appArg = args[i].slice(6);
    else if (!args[i].startsWith('-')) appArg = args[i];
  }

  // 1. 客户端与补丁目录
  let app = appArg || '';
  if (!app || !fs.existsSync(path.join(distDirOf(app), 'index.html'))) {
    app = appRootCandidates().find((c) => fs.existsSync(path.join(distDirOf(c), 'index.html'))) || '';
  }
  if (!app) {
    bad('未找到 Kimi Code 桌面客户端（含 desktop-dist 的应用包）');
    console.log('建议：确认客户端已安装；若装在其他位置，用 --app 参数指定');
    process.exitCode = 1;
    return;
  }
  ok(`客户端：${app}`);
  const dist = distDirOf(app);
  const vib = path.join(dist, 'kcm');
  console.log(`INFO  客户端版本：${readClientVersion(app)}`);

  // 2. 补丁文件完整性
  if (!fs.existsSync(vib)) {
    bad(`补丁目录不存在（${vib}）——面板未安装，或客户端更新后补丁被清除`);
    console.log('建议：重跑安装流程（install.md）');
    process.exitCode = 1;
    return;
  }
  for (const f of ['loader.js', 'panel-app.js', 'content.css', 'rive/rive.js', 'rive/rive.wasm']) {
    if (fs.existsSync(vib) && fs.statSync(path.join(vib, f)).size > 0) ok(`文件存在：${f}`);
    else bad(`文件缺失或为空：${f}（建议重装）`);
  }
  if (fs.existsSync(path.join(vib, 'VERSION'))) ok(`补丁版本：${fs.readFileSync(path.join(vib, 'VERSION'), 'utf8').trim()}`);
  else warnFn('补丁无版本标记（较老版本，建议重装升级）');

  // 3. index.html 注入标签与缓存参数一致性
  const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  const tag = html.match(/kcm\/loader\.js\?v=[a-f0-9]*/)?.[0] || '';
  if (!tag) {
    bad('index.html 无 loader 注入标签——补丁未生效');
    console.log('建议：重跑安装流程');
  } else if (fs.existsSync(path.join(dist, `index.html${BACKUP_SUFFIX}`))) {
    ok(`注入标签存在（${tag}），原始备份在场`);
  } else {
    warnFn('注入标签存在，但原始备份缺失（卸载时只能删标签无法整体还原）');
  }
  if (tag) {
    const expect = payloadHash(vib);
    const actual = tag.split('v=')[1];
    if (expect === actual) ok(`缓存参数与载荷哈希一致（${actual}）`);
    else {
      bad(`缓存参数过期（页面 v=${actual}，实际载荷 v=${expect}）——客户端可能加载旧缓存`);
      console.log('建议：重跑安装流程刷新标签');
    }
  }

  // 4. 数据文件
  const daily = path.join(vib, 'usage-daily.js');
  if (fs.existsSync(daily) && fs.statSync(daily).size > 0) {
    if (fs.readFileSync(daily, 'utf8').slice(0, 40).includes('__kcmUsageDaily')) ok('历史统计数据文件在位');
    else bad('usage-daily.js 内容异常（应以 window.__kcmUsageDaily 开头）');
  } else {
    warnFn('无历史统计数据文件（全新环境正常；否则重跑安装预填）');
  }
  const external = path.join(vib, 'external.js');
  if (fs.existsSync(external) && fs.statSync(external).size > 0) ok(`外部账户快照在位（${fmtMtime(external)}）`);
  else console.log('INFO  无外部账户快照（未配置外部账户，正常）');

  // 5. kap 本地服务（发现 + 探测）
  let kapPort = '';
  const instancesDir = path.join(process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code'), 'server', 'instances');
  let entries = [];
  try { entries = fs.readdirSync(instancesDir); } catch (error) { /* 目录不存在 */ }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    let port;
    try { port = JSON.parse(fs.readFileSync(path.join(instancesDir, name), 'utf8')).port; } catch (error) { continue; }
    if (!port) continue;
    if (await httpStatus(port, '/api/v1/oauth/usage') === 200) { kapPort = String(port); break; }
  }
  if (kapPort) {
    ok(`本地服务在线（端口 ${kapPort}，额度接口 200）`);
    const code = await httpStatus(Number(kapPort), '/kcm/loader.js');
    if (code === 200) ok('本地服务能伺服补丁文件（/kcm/loader.js 200）');
    else warnFn(`本地服务未伺服补丁文件（HTTP ${code}）——面板可能依赖注入标签本地路径`);
  } else {
    bad('本地服务不可达（无实例注册或额度接口非 200）——客户端可能未运行');
    console.log('建议：确认 Kimi Code 客户端正在运行后重试');
  }

  console.log('-----');
  console.log(`结论：PASS=${pass} FAIL=${fail} WARN=${warn}`);
  if (fail === 0) console.log('外部检查全部通过。页面内状态请按 doctor.md 的页面级通道继续。');
  process.exitCode = fail > 0 ? 1 : 0;
}

// 直接执行时跑 CLI（被 import 时不跑）。realpath 理由同 install.mjs：
// macOS 的 /tmp 是 /private/tmp 的符号链接，不对齐会静默不执行。
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main();
}
