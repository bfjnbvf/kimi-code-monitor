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

// 当前字段为 amount；amountLeft 仅为旧版返回的临时兼容，后续删除。两者单位均为 1e-8 元
function walletAmountLeft(wallet) {
  const rawAmount = wallet?.balance?.amountLeft ?? wallet?.balance?.amount;
  if (rawAmount == null || rawAmount === '') return null;
  const amountLeft = Number(rawAmount);
  return Number.isFinite(amountLeft) ? amountLeft : null;
}

function walletSnapshot(wallet) {
  const amountLeft = walletAmountLeft(wallet);
  if (amountLeft == null) return null;
  return {
    status: typeof wallet.status === 'string' ? wallet.status : '',
    balance: { amountLeft }
  };
}

// 与扩展 boosterBalanceYuan（metrics.js）同口径：单位 → 元
function balanceYuan(wallet) {
  const status = String(wallet?.status || '').toUpperCase();
  if (status !== 'STATUS_ACTIVE' && status !== 'STATUS_ENABLED') return 0;
  const amountLeft = walletAmountLeft(wallet);
  return amountLeft == null ? null : Math.max(0, amountLeft / 100_000_000);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.out) {
    console.error('用法: node fetch-wallet.mjs --out <wallet.js路径>');
    process.exit(1);
  }
  // 凭据位置尊重 KIMI_CODE_HOME（与 install.mjs 的 kimiHome 同口径）：
  // 自定义根目录时 ~/.kimi-code 下没有凭据，写死 home 会静默跳过余额快照
  const credPath = path.join(
    process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code'),
    'credentials',
    'kimi-code.json'
  );
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

  const safeWallet = walletSnapshot(wallet);
  if (!safeWallet) {
    console.error('[wallet] 余额字段格式异常，未写入快照');
    process.exit(4);
  }
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  const staged = `${args.out}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(staged, `window.__kcmWallet = ${JSON.stringify({ wallet: safeWallet, fetchedAt: new Date().toISOString() })};\n`, { mode: 0o600 });
    fs.renameSync(staged, args.out);
  } catch (error) {
    fs.rmSync(staged, { force: true });
    throw error;
  }
  const yuan = balanceYuan(wallet);
  console.log(`[wallet] 余额快照已写入 ${args.out}（剩余 ${yuan == null ? '未知' : `¥${yuan.toFixed(2)}`}）`);
}

// 直接执行时跑 CLI（realpath 对齐符号链接路径，见 scan.mjs 同款注释）
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  await main();
}

export { balanceYuan, walletSnapshot };
