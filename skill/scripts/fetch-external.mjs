#!/usr/bin/env node
/**
 * 外部账户余额快照抓取（技能 scripts，Node ≥18）
 *
 * 用各家 provider 的 API key 抓一次余额，写进补丁数据文件 external.js，
 * 面板 loader 轮询到后推给「外部账户」模块显示（快照，带截至时间）。
 *
 * 安全约定（技能文档同步强调）：
 * - key 只用于本次请求，不写任何文件、不出现在任何输出里
 * - 输出只含 key 尾 4 位（keyTail）供用户辨认
 * - 每次运行整体替换快照；不维护 key 的持久存储
 *
 * 用法：
 *   node fetch-external.mjs --fetch '[{"provider":"deepseek","key":"sk-xxx","label":"主号"}]' \
 *                           --out "<app>/Contents/Resources/desktop-dist/vibepal/external.js"
 *   node fetch-external.mjs --clear --out 同上
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROVIDERS } from '../../src/providers.js';

function parseArgs(argv) {
  const args = { fetch: '', out: '', clear: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--fetch') args.fetch = argv[(i += 1)];
    else if (argv[i] === '--out') args.out = argv[(i += 1)];
    else if (argv[i] === '--clear') args.clear = true;
  }
  return args;
}

function usage() {
  console.error('用法: node fetch-external.mjs --fetch <json数组> --out <external.js路径> | --clear --out <路径>');
  console.error('  json数组元素: {"provider":"deepseek|kimiapi|zhipu|minimax","key":"...","label":"可选备注"}');
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.out || (!args.fetch && !args.clear)) usage();

  if (args.clear) {
    fs.rmSync(args.out, { force: true });
    console.log('[external] 已清空外部账户快照');
    return;
  }

  let accounts;
  try {
    accounts = JSON.parse(args.fetch);
  } catch (error) {
    console.error('[external] --fetch 参数不是合法 JSON');
    process.exit(1);
  }
  if (!Array.isArray(accounts) || accounts.length === 0) usage();

  const providers = [];
  for (const account of accounts) {
    const providerId = String(account?.provider || '');
    const key = String(account?.key || '');
    const provider = PROVIDERS[providerId];
    const keyTail = key.slice(-4);
    const base = {
      id: `ext-${providerId}-${keyTail}`,
      provider: providerId,
      name: account.label || provider?.name || providerId,
      keyTail
    };
    if (!provider) {
      providers.push({ ...base, error: '未知 provider' });
      continue;
    }
    try {
      const result = await provider.fetch(key);
      providers.push({ ...base, ...result, error: '' });
      console.log(`[external] ${base.name}（…${keyTail}）抓取成功`);
    } catch (error) {
      providers.push({ ...base, error: error?.message || String(error) });
      console.error(`[external] ${base.name}（…${keyTail}）失败：${error?.message || error}`);
    }
  }

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  const payload = { fetchedAt: new Date().toISOString(), providers };
  fs.writeFileSync(args.out, `window.__vibepalExternal = ${JSON.stringify(payload)};\n`);
  const ok = providers.filter((p) => !p.error).length;
  console.log(`[external] 快照已写入 ${args.out}（成功 ${ok}/${providers.length}，面板重载或稍后自动刷新可见）`);
}

// 直接执行时跑 CLI（realpath 对齐符号链接路径，见 scan.mjs 同款注释）
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  await main();
}
