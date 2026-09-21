#!/usr/bin/env node
/**
 * 客户端供应商探测（跨平台：macOS / Windows，Node ≥16）
 *
 * 外部账户的来源就是客户端自己的供应商配置（`~/.kimi-code/config.toml`，
 * 在客户端「模型设置」里加的那个）。本脚本走本机 kap-server 的只读接口读它：
 *   GET /api/v1/providers        列出供应商（只给 has_api_key，不给 key）
 * 然后按面板的适配表分三类打印报告——已接入外部账户 / 暂不支持余额查询 /
 * 客户端托管账号。面板自己每 60 秒做同一件事，本脚本是给安装与排障看结果用的。
 *
 * 安全约定：只读客户端配置，不写任何文件；连 key 都不读（列表接口只给布尔）。
 *
 * 用法：
 *   node client-providers.mjs                                  探测并打印报告
 *   node client-providers.mjs --port 61545                     手动指定端口
 * 退出码：0 成功；1 探测不到运行中的客户端（未启动 / 补丁未装）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { classifyClientProvider } from '../../src/providers.js';

/* ---------- 客户端服务（kap-server）定位 ---------- */

/** 实例注册文件里的端口：`~/.kimi-code/server/instances/<server_id>.json`
 * 由客户端与 CLI 自己写（含 port / heartbeat_at），跨平台可靠，优先用它。 */
function registryPorts() {
  const dir = path.join(process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code'), 'server', 'instances');
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    return [];
  }
  const found = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const info = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (info?.port) found.push({ port: Number(info.port), heartbeatAt: Number(info.heartbeat_at) || 0 });
    } catch (error) {
      // 半个写坏的文件跳过
    }
  }
  // 心跳最新的排前面（同时装着 CLI 与桌面端时，取更活跃的那个）
  return found.sort((a, b) => b.heartbeatAt - a.heartbeatAt).map((item) => item.port);
}

/** 注册文件不可用时的兜底：POSIX 用 lsof、Windows 用 netstat 找候选端口。 */
function listeningPorts() {
  const ports = new Set();
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 8000 });
      for (const line of out.split('\n')) {
        const m = /^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING/i.exec(line);
        if (m) ports.add(Number(m[1]));
      }
    } else {
      const out = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 8000 });
      for (const line of out.split('\n')) {
        // 只认客户端自己的进程名（lsof 把空格写成 \x20）
        if (!/kimi/i.test(line)) continue;
        const m = /127\.0\.0\.1:(\d+)/.exec(line);
        if (m) ports.add(Number(m[1]));
      }
    }
  } catch (error) {
    return [];
  }
  return [...ports];
}

/** 逐个候选端口试探 /api/v1/meta：返回带 server_id 的那个才是客户端服务。 */
async function findKap(portArg) {
  const candidates = portArg
    ? [Number(portArg)]
    : [...registryPorts(), ...listeningPorts()];
  for (const port of candidates) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/v1/meta`, { signal: AbortSignal.timeout(2000) });
      if (!r.ok) continue;
      const body = await r.json();
      if (body?.data?.server_id) return { port, meta: body.data };
    } catch (error) {
      // 该端口不是客户端服务（CLI 的 web 服务 / 其他本地工具）：继续试下一个
    }
  }
  return null;
}

async function readProviders(port) {
  const r = await fetch(`http://127.0.0.1:${port}/api/v1/providers`, { signal: AbortSignal.timeout(5000) });
  const body = await r.json();
  return Array.isArray(body?.data?.items) ? body.data.items : [];
}

async function readProviderKey(port, id) {
  const r = await fetch(`http://127.0.0.1:${port}/api/v1/providers/${encodeURIComponent(id)}`, {
    signal: AbortSignal.timeout(5000)
  });
  const body = await r.json();
  return typeof body?.data?.api_key === 'string' ? body.data.api_key : '';
}

/* ---------- 分类与报告 ---------- */

/** 客户端 provider 列表 → 三类（与面板同一份判断，见 src/providers.js）。 */
function classify(providers) {
  const supported = [];
  const unsupported = [];
  const managed = [];
  for (const item of providers) {
    const id = typeof item?.id === 'string' ? item.id : '(未命名)';
    const info = classifyClientProvider(item);
    if (info.kind === 'managed') {
      managed.push({ id, host: info.host, reason: info.reason });
      continue;
    }
    if (info.kind === 'unsupported') {
      unsupported.push({ id, host: info.host, reason: info.reason });
      continue;
    }
    if (item.has_api_key === false) {
      unsupported.push({ id, host: info.host, reason: '未配置 API key' });
      continue;
    }
    supported.push({ id, host: info.host, adapter: info.adapter });
  }
  return { supported, unsupported, managed };
}

function printReport(port, groups) {
  const { supported, unsupported, managed } = groups;
  const total = supported.length + unsupported.length + managed.length;
  console.log(`INFO  客户端服务：127.0.0.1:${port}`);
  console.log(`INFO  自动探测到 ${total} 个供应商（来自客户端自己的配置）：`);
  let index = 0;
  for (const item of supported) {
    index += 1;
    console.log(`       ${index}) ${item.id}（${item.host || '未识别域名'}）→ 已接入外部账户：${item.adapter.typeLabel}`);
  }
  for (const item of unsupported) {
    index += 1;
    console.log(`       ${index}) ${item.id}（${item.host || '未识别域名'}）→ 暂不支持余额查询：${item.reason}`);
  }
  for (const item of managed) {
    index += 1;
    console.log(`       ${index}) ${item.id}（${item.host || '未识别域名'}）→ ${item.reason}`);
  }
  console.log(
    `SUMMARY 探测 ${total} 个：已接入外部账户 ${supported.length} 个 · 不支持余额查询 ${unsupported.length} 个 · 客户端托管账号 ${managed.length} 个`
  );
}

/* ---------- CLI ---------- */

function parseArgs(argv) {
  const args = { port: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--port') args.port = argv[(i += 1)] || '';
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const kap = await findKap(args.port);
  if (!kap) {
    console.error('FAIL  探测不到运行中的 Kimi Code 客户端（未启动，或补丁未装）');
    console.error('建议：先打开客户端；若刚更新过客户端，重跑安装流程（install.md）');
    process.exit(1);
  }
  printReport(kap.port, classify(await readProviders(kap.port)));
}

// 直接执行时跑 CLI（realpath 对齐符号链接路径，见 scan.mjs 同款注释）
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  await main();
}
