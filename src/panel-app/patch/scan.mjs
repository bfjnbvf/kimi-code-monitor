#!/usr/bin/env node
/**
 * usage-daily 生成器（安装器调用，Node ≥16）
 *
 * 全量扫描 ~/.kimi-code/sessions 下各会话 agents 目录里的 wire.jsonl，
 * 把每条 usage.record 按天/按小时聚合成补丁面板直接加载的 usage-daily.js。
 *
 * 行解析与按天/按小时聚合复用扩展的 cli-usage.js 纯函数——浏览器侧
 * （扩展统计）与本脚本（安装器预填）永远同口径，不会各算各的。
 * 全新环境没有 sessions 目录或没有 node 时安装器会跳过预填，
 * 面板从安装时刻开始积累（页内 accumulate.js 兜底）。
 *
 * 用法：
 *   node scan.mjs --sessions ~/.kimi-code/sessions --out <path>/usage-daily.js
 *   node scan.mjs --stdout            # 结果打到标准输出
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
import { parseUsageLines } from '../../cli-usage.js';
import { isSessionDirName, isSubagentAgentName } from '../../session-files.js';
import * as KimiMetrics from '../../metrics.js';

const READ_CHUNK_BYTES = 4 * 1024 * 1024;

/** 枚举 sessions 下的 wire.jsonl（命名规则见 session-files.js，与扩展侧同一份） */
export function listWireFiles(sessionsDir) {
  const files = [];
  let workspaces;
  try {
    workspaces = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch (error) {
    return files;
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const workspaceDir = path.join(sessionsDir, workspace.name);
    let sessions;
    try {
      sessions = fs.readdirSync(workspaceDir, { withFileTypes: true });
    } catch (error) {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory() || !isSessionDirName(session.name)) continue;
      const agentsDir = path.join(workspaceDir, session.name, 'agents');
      let agents;
      try {
        agents = fs.readdirSync(agentsDir, { withFileTypes: true });
      } catch (error) {
        continue;
      }
      for (const agent of agents) {
        if (!agent.isDirectory()) continue;
        const wire = path.join(agentsDir, agent.name, 'wire.jsonl');
        if (!fs.existsSync(wire)) continue;
        files.push({
          // 这里是文件系统路径（读取用），不是跨会话汇总键
          path: wire,
          isSubagent: isSubagentAgentName(agent.name)
        });
      }
    }
  }
  return files;
}

/** 流式读单个文件：按完整行喂给 parseUsageLines，跨块的多字节字符由
 *  StringDecoder 兜住；末尾未写完的行（无换行符）跳过，下次重扫补齐 */
function scanFileStream(filePath, daily, hourly, isSubagent) {
  const decoder = new StringDecoder('utf8');
  let carry = '';
  let records = 0;
  const buffer = Buffer.alloc(READ_CHUNK_BYTES);
  const fd = fs.openSync(filePath, 'r');
  try {
    let read;
    while ((read = fs.readSync(fd, buffer, 0, READ_CHUNK_BYTES, null)) > 0) {
      const text = carry + decoder.write(buffer.subarray(0, read));
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline < 0) {
        carry = text;
        continue;
      }
      carry = text.slice(lastNewline + 1);
      records += parseUsageLines(text.slice(0, lastNewline + 1), daily, hourly, isSubagent);
    }
    const tail = carry + decoder.end();
    if (tail.includes('\n')) {
      // 末块解码尾巴恰好凑出完整行时也计入（罕见但零成本）
      records += parseUsageLines(tail.slice(0, tail.lastIndexOf('\n') + 1), daily, hourly, isSubagent);
    }
  } finally {
    fs.closeSync(fd);
  }
  return records;
}

/** 与 cli-usage.js readSecondaryModelAlias 同正则：[secondary_model] 的 model 字段 */
function readSecondaryModel(kimiHome) {
  try {
    const text = fs.readFileSync(path.join(kimiHome, 'config.toml'), 'utf8');
    const match = text.match(/\[secondary_model\][\s\S]*?model\s*=\s*"([^"]+)"/);
    return match ? match[1] : '';
  } catch (error) {
    return '';
  }
}

/** 全量扫描：返回 { daily, hourly, secondaryModel, fileCount, recordCount, failures } */
export function scanSessions(sessionsDir) {
  const daily = {};
  const hourly = {};
  const failures = [];
  const files = listWireFiles(sessionsDir);
  let recordCount = 0;
  for (const entry of files) {
    try {
      recordCount += scanFileStream(entry.path, daily, hourly, entry.isSubagent);
    } catch (error) {
      // 单文件损坏/权限抖动跳过，不中断整次扫描（与扩展扫描同策略）
      failures.push(`${entry.path}: ${error?.message || error}`);
    }
  }
  return {
    daily: KimiMetrics.pruneDailyUsage(daily),
    hourly: KimiMetrics.pruneHourlyUsage(hourly),
    secondaryModel: readSecondaryModel(path.dirname(path.resolve(sessionsDir))),
    fileCount: files.length,
    recordCount,
    failures
  };
}

/** 渲染成补丁页面加载的 usage-daily.js 内容 */
export function renderUsageDailyJs(data) {
  const payload = {
    daily: data.daily || {},
    hourly: data.hourly || {},
    secondaryModel: typeof data.secondaryModel === 'string' ? data.secondaryModel : ''
  };
  return `window.__kcmUsageDaily = ${JSON.stringify(payload)};\n`;
}

/* ---------- CLI ---------- */

function parseArgs(argv) {
  const args = { sessions: path.join(os.homedir(), '.kimi-code', 'sessions'), out: '', stdout: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--sessions') args.sessions = argv[(i += 1)];
    else if (argv[i] === '--out') args.out = argv[(i += 1)];
    else if (argv[i] === '--stdout') args.stdout = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.stdout && !args.out) {
    console.error('用法: node scan.mjs --sessions <dir> --out <file> | --stdout');
    process.exit(1);
  }
  if (!fs.existsSync(args.sessions)) {
    console.error(`[scan] sessions 目录不存在：${args.sessions}（全新环境？无历史可预填）`);
    process.exit(2);
  }
  const startedAt = Date.now();
  const result = scanSessions(args.sessions);
  const js = renderUsageDailyJs(result);
  if (args.stdout) {
    process.stdout.write(js);
  } else {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, js);
  }
  const days = Object.keys(result.daily).sort();
  console.error(
    `[scan] 文件 ${result.fileCount} · 记录 ${result.recordCount} · 天数 ${days.length}`
    + (days.length ? `（${days[0]} ~ ${days[days.length - 1]}）` : '')
    + ` · 耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
    + (result.failures.length ? ` · 失败文件 ${result.failures.length}（已跳过）` : '')
  );
  for (const failure of result.failures.slice(0, 5)) console.error(`[scan]   ${failure}`);
}

// 直接执行时跑 CLI（被 import 时不跑；esbuild 打包后依然成立）。
// 必须先 realpath：macOS 的 /tmp 是 /private/tmp 的符号链接，Node 会把主模块
// 解析成真实路径写进 import.meta.url，argv[1] 却保留调用时的符号链接路径，
// 不对齐的话经符号链接调用（智能体常在 /tmp 解压执行）会静默不执行 main。
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main();
}
