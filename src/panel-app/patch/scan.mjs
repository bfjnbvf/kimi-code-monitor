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
 *   node scan.mjs                     # 原地重写同目录的 usage-daily.js（技能刷新用）
 *   node scan.mjs --sessions ~/.kimi-code/sessions --out <path>/usage-daily.js
 *   node scan.mjs --stdout            # 结果打到标准输出
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  combineFileDaily,
  combineFileHourly,
  emptyScanMeta,
  parseUsageLines,
  summarizeSessions
} from '../../cli-usage.js';
import { isSessionDirName, isSubagentAgentName, wirePathOf } from '../../session-files.js';

const READ_CHUNK_BYTES = 4 * 1024 * 1024;

/** 枚举 sessions 下的 wire.jsonl（命名规则见 session-files.js，与扩展侧同一份）。
 *  返回 path（文件系统路径，读取用）与 key（跨会话汇总键，与扩展侧索引同形）。 */
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
          path: wire,
          key: wirePathOf(workspace.name, session.name, agent.name),
          // agents/main 为主代理，其余（agent-N 等）按子代理分桶
          isSubagent: isSubagentAgentName(agent.name)
        });
      }
    }
  }
  return files;
}

/** 流式读单个文件：按完整行喂给 parseUsageLines，跨块的多字节字符由
 *  StringDecoder 兜住；末尾未写完的行（无换行符）跳过，下次重扫补齐 */
function scanFileStream(filePath, daily, hourly, isSubagent, meta) {
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
      records += parseUsageLines(text.slice(0, lastNewline + 1), daily, hourly, isSubagent, meta);
    }
    const tail = carry + decoder.end();
    if (tail.includes('\n')) {
      // 末块解码尾巴恰好凑出完整行时也计入（罕见但零成本）
      records += parseUsageLines(tail.slice(0, tail.lastIndexOf('\n') + 1), daily, hourly, isSubagent, meta);
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

/** 全量扫描：返回 { daily, hourly, sessions, secondaryModel, fileCount, recordCount, failures }
 *
 *  逐文件的 daily/hourly/meta 先落进索引，再交给扩展侧的合并函数——
 *  「按天/按小时」的合流与「按会话（代理 × 模型）」的汇总都只有一份实现，
 *  面板预填与扩展扫描永远同口径。 */
export function scanSessions(sessionsDir) {
  const files = {};
  const failures = [];
  let recordCount = 0;
  for (const entry of listWireFiles(sessionsDir)) {
    // 单文件损坏/权限抖动跳过，不中断整次扫描（与扩展扫描同策略）
    const meta = emptyScanMeta();
    const fileDaily = {};
    const fileHourly = {};
    try {
      recordCount += scanFileStream(entry.path, fileDaily, fileHourly, entry.isSubagent, meta);
      files[entry.key] = { daily: fileDaily, hourly: fileHourly, meta };
    } catch (error) {
      failures.push(`${entry.path}: ${error?.message || error}`);
    }
  }
  return {
    daily: combineFileDaily(files),
    hourly: combineFileHourly(files),
    sessions: summarizeSessions(files),
    secondaryModel: readSecondaryModel(path.dirname(path.resolve(sessionsDir))),
    fileCount: Object.keys(files).length,
    recordCount,
    failures
  };
}

/** 渲染成补丁页面加载的 usage-daily.js 内容 */
export function renderUsageDailyJs(data) {
  const payload = {
    daily: data.daily || {},
    hourly: data.hourly || {},
    // 按会话（代理 × 模型）汇总：切会话时做本地恢复底数，服务端不给历史时唯一的真值来源
    sessions: data.sessions || {},
    secondaryModel: typeof data.secondaryModel === 'string' ? data.secondaryModel : ''
  };
  return `window.__kcmUsageDaily = ${JSON.stringify(payload)};\n`;
}

/* ---------- CLI ---------- */

function parseArgs(argv) {
  const args = {
    sessions: path.join(os.homedir(), '.kimi-code', 'sessions'),
    // 默认原地重写：脚本自己就在补丁载荷目录（desktop-dist/kcm/）里，
    // 技能「刷新本地统计」因此不需要知道任何路径
    out: path.join(path.dirname(fileURLToPath(import.meta.url)), 'usage-daily.js'),
    stdout: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--sessions') args.sessions = argv[(i += 1)];
    else if (argv[i] === '--out') args.out = argv[(i += 1)];
    else if (argv[i] === '--stdout') args.stdout = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
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
    + ` · 会话 ${Object.keys(result.sessions).length}`
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
