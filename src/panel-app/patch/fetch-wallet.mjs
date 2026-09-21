#!/usr/bin/env node
/**
 * 加油包余额快照（安装器/技能调用，Node ≥18）
 *
 * 用 Kimi Code 客户端自己的凭据（~/.kimi-code/credentials/kimi-code.json）
 * 调官方 usages API，把 booster 余额写成 wallet.js，面板 loader 轮询后经
 * quota 消息的 wallet 字段点亮余额显示。
 *
 * 安全约定：凭据 token 只进请求头——不回显、不写任何文件；wallet.js 里
 * 只有余额数据。
 *
 * 用法：node fetch-wallet.mjs --out "<app>/Contents/Resources/desktop-dist/kcm/wallet.js"
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const USAGES_API = 'https://api.kimi.com/coding/v1/usages';

function parseArgs(argv) {
  const args = { out: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') args.out = argv[(i += 1)];
  }
  return args;
}

// 与扩展 boosterBalanceYuan（metrics.js）同口径：单位 → 元
function balanceYuan(wallet) {
  const status = String(wallet?.status || '').toUpperCase();
  if (status !== 'STATUS_ACTIVE' && status !== 'STATUS_ENABLED') return 0;
  const amountLeft = Number(wallet?.balance?.amountLeft);
  return Number.isFinite(amountLeft) ? Math.max(0, amountLeft / 100_000_000) : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.out) {
    console.error('用法: node fetch-wallet.mjs --out <wallet.js路径>');
    process.exit(1);
  }
  const credPath = path.join(os.homedir(), '.kimi-code', 'credentials', 'kimi-code.json');
  let token = '';
  try {
    token = String(JSON.parse(fs.readFileSync(credPath, 'utf8')).access_token || '');
  } catch (error) {
    console.error('[wallet] 未找到客户端凭据（~/.kimi-code/credentials/kimi-code.json）：打开一次 Kimi Code 客户端后重试');
    process.exit(2);
  }
  if (!token) {
    console.error('[wallet] 凭据里没有 access_token：打开一次 Kimi Code 客户端后重试');
    process.exit(2);
  }

  let body;
  try {
    const response = await fetch(USAGES_API, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000)
    });
    if (response.status === 401 || response.status === 403) {
      console.error('[wallet] 凭据已失效（401/403）：打开一次 Kimi Code 客户端（会自动续期）后重试');
      process.exit(2);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    body = await response.json();
  } catch (error) {
    console.error(`[wallet] 请求失败：${error?.message || error}`);
    process.exit(1);
  }

  // API 字段名经历过 boosterWallet → booster_wallet 变更，双读兼容
  const wallet = body?.booster_wallet ?? body?.boosterWallet ?? null;
  if (!wallet || typeof wallet !== 'object') {
    console.error('[wallet] 响应里没有加油包余额字段（账号可能没有加油包）');
    process.exit(3);
  }

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `window.__kcmWallet = ${JSON.stringify({ wallet, fetchedAt: new Date().toISOString() })};\n`);
  const yuan = balanceYuan(wallet);
  console.log(`[wallet] 余额快照已写入 ${args.out}（剩余 ${yuan == null ? '未知' : `¥${yuan.toFixed(2)}`}）`);
}

// 直接执行时跑 CLI（realpath 对齐符号链接路径，见 scan.mjs 同款注释）
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  await main();
}
