#!/usr/bin/env node
/**
 * 刷新面板的本地统计（跨平台：macOS / Windows，Node ≥16）。
 *
 * 定位客户端补丁目录里的 scan.mjs 并运行它：重扫 ~/.kimi-code/sessions 下的
 * 会话日志，原地重写同目录的 usage-daily.js（按天/按小时统计 + 按会话的
 * 「代理 × 模型」汇总）。面板每 30 秒轮询该文件，内容一变就自己更新——
 * 不需要重装补丁，也不需要重载客户端。
 *
 * 什么时候用：面板上「今天的用量 / 按天图表 / 代理明细」落后于实际，
 * 或者刚做完一段对话想让面板立刻反映出来。
 *
 * 用法：node refresh-stats.mjs [--app <客户端目录>]
 * 退出码：0 成功；1 找不到补丁 / 客户端；2 没有会话日志目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const APP_NAME = 'Kimi Code';
const PAYLOAD_DIR = 'kcm';

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

function parseArgs(argv) {
  let appArg = '';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--app') appArg = argv[(i += 1)] || '';
    else if (argv[i].startsWith('--app=')) appArg = argv[i].slice('--app='.length);
  }
  return { appArg };
}

const { appArg } = parseArgs(process.argv.slice(2));
const appRoot = appArg
  ? path.resolve(appArg)
  : appRootCandidates().find((c) => fs.existsSync(path.join(distDirOf(c), PAYLOAD_DIR, 'scan.mjs')));
if (!appRoot) {
  console.error('[refresh] 未找到已装补丁的 Kimi Code 客户端（需要 desktop-dist/kcm/scan.mjs）');
  console.error('[refresh] 客户端装在其他位置：node refresh-stats.mjs --app <客户端目录>；未装补丁请先安装');
  process.exit(1);
}

const kimiHome = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
const sessions = path.join(kimiHome, 'sessions');
if (!fs.existsSync(sessions)) {
  console.error(`[refresh] 没有会话日志目录 ${sessions}（本机还没跑过 Kimi Code？）`);
  process.exit(2);
}

const tool = path.join(distDirOf(appRoot), PAYLOAD_DIR, 'scan.mjs');
const out = path.join(distDirOf(appRoot), PAYLOAD_DIR, 'usage-daily.js');
const before = fs.existsSync(out) ? fs.statSync(out).size : 0;
try {
  execFileSync(process.execPath, [tool, '--sessions', sessions, '--out', out], { stdio: 'inherit' });
} catch (error) {
  console.error('[refresh] 扫描失败，本地统计保持原样（旧文件未被破坏）');
  process.exit(1);
}
const after = fs.existsSync(out) ? fs.statSync(out).size : 0;
console.error(`[refresh] 本地统计已刷新（${before} → ${after} 字节），面板最多 30 秒后自动跟上`);
