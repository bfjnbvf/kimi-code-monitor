'use strict';

import * as KimiMetrics from './metrics.js';
import { isSessionDirName, isSubagentAgentName, wirePathOf, parseWirePath } from './session-files.js';

const DB_NAME = 'kimi-code-monitor';
const HANDLE_STORE = 'file-handles';
const SESSIONS_HANDLE_KEY = 'kimi-cli-sessions';
const DAILY_STORAGE_KEY = 'kimiCliUsageDaily';
const HOURLY_STORAGE_KEY = 'kimiCliUsageHourly';
const INDEX_STORAGE_KEY = 'kimiCliUsageIndex';
const STATE_STORAGE_KEY = 'kimiCliUsageState';
const SESSIONS_STORAGE_KEY = 'kimiCliUsageSessions';
const SECONDARY_MODEL_STORAGE_KEY = 'kimiCliSecondaryModel';
// 按会话汇总只保留最近有活动的若干条，避免长期无限增长
const SESSIONS_SUMMARY_LIMIT = 200;
// 索引版本 = 网页版唯一的「一次性重建」开关：桶结构 / 统计口径有任何变更
// 都必须 bump 这里，旧索引随即整体作废、下次扫描全量重建（真值在 wire.jsonl，
// 可重建，因此不写逐版本迁移）。补丁侧的页内积累同构，见 panel-app/accumulate.js
// 的 BUCKET_VERSION。
// v4：meta 新增 modelAlias（config.update 里的真实模型名），旧缓存没有，必须全量重扫一次
// v5：新增按小时聚合（hourly，供 24h 图表分柱），旧缓存没有，必须全量重扫一次
// v6：meta.models 由「模型 → token 权重数字」改为「模型 → 用量桶」，按会话汇总
//     随之改成一行一个（代理 × 模型），旧缓存没有桶结构，必须全量重扫一次
const INDEX_VERSION = 6;
const READ_CHUNK_BYTES = 1024 * 1024;

function openHandleDb() {
  return new Promise((resolve, reject) => {
    // 不显式指定版本：本库可能被其他模块升过级，写死低版本会报 VersionError；
    // 不存在时以 v1 创建并触发 onupgradeneeded
    const request = indexedDB.open(DB_NAME);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE)) db.createObjectStore(HANDLE_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法打开本地目录授权存储'));
  });
}

async function withHandleStore(mode, operation) {
  const db = await openHandleDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(HANDLE_STORE, mode);
      const request = operation(transaction.objectStore(HANDLE_STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('本地目录授权存储失败'));
      transaction.onabort = () => reject(transaction.error || new Error('本地目录授权事务失败'));
    });
  } finally {
    db.close();
  }
}

function saveDirectoryHandle(handle) {
  return withHandleStore('readwrite', (store) => store.put(handle, SESSIONS_HANDLE_KEY));
}

function getDirectoryHandle() {
  return withHandleStore('readonly', (store) => store.get(SESSIONS_HANDLE_KEY));
}

function clearDirectoryHandle() {
  return withHandleStore('readwrite', (store) => store.delete(SESSIONS_HANDLE_KEY));
}

async function permissionState(handle) {
  if (!handle || typeof handle.queryPermission !== 'function') return 'missing';
  try {
    return await handle.queryPermission({ mode: 'read' });
  } catch (error) {
    return 'denied';
  }
}

// 桶口径与页内积累（panel-app/accumulate.js）共用 metrics.js 的唯一真源
const emptyBucket = KimiMetrics.emptyUsageBucket;

function addBucket(target, source) {
  target.input += KimiMetrics.toNonNegativeInteger(source?.input);
  target.output += KimiMetrics.toNonNegativeInteger(source?.output);
  target.cacheRead += KimiMetrics.toNonNegativeInteger(source?.cacheRead);
}

function addUsageRecord(daily, record, isSubagent = false, meta = null) {
  if (record?.type !== 'usage.record' || !record.usage) return false;
  const time = Number(record.time);
  if (!Number.isFinite(time)) return false;
  const usage = KimiMetrics.normalizeUsage(record.usage);
  const key = KimiMetrics.usageDayKey(new Date(time));
  const bucket = { ...emptyBucket(), ...(daily[key] || {}) };
  KimiMetrics.addUsageToBucket(bucket, usage);
  if (isSubagent) {
    // 子代理同额累加进 sub 子桶，供主/子代理堆叠展示
    const sub = { ...emptyBucket(), ...(bucket.sub || {}) };
    KimiMetrics.addUsageToBucket(sub, usage);
    bucket.sub = sub;
  }
  daily[key] = bucket;
  if (meta) {
    // 按模型分桶与记录时间范围，供按「代理 × 模型」展示（不记录任何文本内容）
    KimiMetrics.addModelUsage(meta.models, record.model, usage);
    if (meta.firstAt == null || time < meta.firstAt) meta.firstAt = time;
    if (meta.lastAt == null || time > meta.lastAt) meta.lastAt = time;
  }
  return true;
}

// 与 addUsageRecord 同口径的按小时聚合（'YYYY-MM-DDTHH' 本地小时键），供 24h 图表分柱
function addHourlyRecord(hourly, record, isSubagent = false) {
  const time = Number(record?.time);
  if (!Number.isFinite(time) || !record.usage) return;
  const usage = KimiMetrics.normalizeUsage(record.usage);
  const key = KimiMetrics.usageHourKey(new Date(time));
  const bucket = { ...emptyBucket(), ...(hourly[key] || {}) };
  KimiMetrics.addUsageToBucket(bucket, usage);
  if (isSubagent) {
    const sub = { ...emptyBucket(), ...(bucket.sub || {}) };
    KimiMetrics.addUsageToBucket(sub, usage);
    bucket.sub = sub;
  }
  hourly[key] = bucket;
}

/** 逐文件扫描的累积器：daily/hourly 之外还要 meta（按模型分桶 + 起止时间 +
 *  config.update 里的真名）——按代理 × 模型的展示全靠它，扫描侧与扩展侧同形。 */
function emptyScanMeta() {
  return { models: {}, firstAt: null, lastAt: null, modelAlias: null };
}

function mergeScanMeta(target, source) {
  if (!source) return target;
  KimiMetrics.mergeModelUsage(target.models, source.models);
  if (source.firstAt != null && (target.firstAt == null || source.firstAt < target.firstAt)) {
    target.firstAt = source.firstAt;
  }
  if (source.lastAt != null && (target.lastAt == null || source.lastAt > target.lastAt)) {
    target.lastAt = source.lastAt;
  }
  // 增量扫描时后扫到的覆盖：文件的模型配置以最新记录为准
  if (typeof source.modelAlias === 'string' && source.modelAlias) {
    target.modelAlias = source.modelAlias;
  }
  return target;
}

function parseUsageLines(text, daily, hourly = null, isSubagent = false, meta = null) {
  let count = 0;
  for (const line of String(text || '').split('\n')) {
    // 先用子串粗筛，避免对话正文进入 JSON 解析器；真实类型由 addUsageRecord
    // 校验 parsed.type === 'usage.record'，不依赖 type 是行内第一个字段。
    if (line.includes('"usage.record"')) {
      try {
        const parsed = JSON.parse(line);
        if (addUsageRecord(daily, parsed, isSubagent, meta)) {
          count += 1;
          if (hourly) addHourlyRecord(hourly, parsed, isSubagent);
        }
      } catch (error) {
        // 单行损坏不阻塞其他会话；未完整写入的末行不会传到这里。
      }
    } else if (meta && line.includes('"config.update"') && line.includes('"modelAlias"')) {
      // config.update 携带解析后的真实模型名（子代理的 usage.record 只写 __secondary__ 占位符）
      try {
        const alias = JSON.parse(line)?.modelAlias;
        if (typeof alias === 'string' && alias) meta.modelAlias = alias;
      } catch (error) {
        // 同上，单行损坏忽略
      }
    }
  }
  return count;
}

function lastNewlineIndex(bytes) {
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    if (bytes[index] === 10) return index;
  }
  return -1;
}

function scanStartOffset(file, previous) {
  // 仅「纯追加」才从上次偏移续扫：上次必须已扫到旧文件尾（offset === size），
  // 且新文件比该偏移更大。追加必然保持该特征；截断重写/原子替换即使新文件
  // 更大也不满足——旧偏移之后的内容已整体换新，复用旧偏移会永久漏计新文件
  // 头部。lastModified 在正常追加时同样会变，无法区分追加与替换，故不作为
  // 判据。其余情况（含 offset 未扫到旧文件尾、同尺寸但 lastModified 变化的
  // 疑似同尺寸重写）一律回退 0 全量重扫，此时 scanFile 的 canAppend 为假，
  // daily/meta 从空重建而非克隆旧值。真正未变的文件由 scanSessionsDirectory
  // 的 unchanged 短路跳过，不依赖这里。
  const offset = Number(previous?.offset);
  const scannedToOldEnd =
    Number.isFinite(offset) && offset >= 0 && offset === Number(previous.size);
  return scannedToOldEnd && offset < file.size ? offset : 0;
}

async function scanFile(file, previous, onBytesProcessed, isSubagent = false) {
  let offset = scanStartOffset(file, previous);
  const canAppend = offset > 0;
  const daily = canAppend && previous.daily && typeof previous.daily === 'object'
    ? structuredClone(previous.daily)
    : {};
  const hourly = canAppend && previous.hourly && typeof previous.hourly === 'object'
    ? structuredClone(previous.hourly)
    : {};
  let usageRecords = canAppend ? KimiMetrics.toNonNegativeInteger(previous.usageRecords) : 0;
  const meta = canAppend && previous.meta && typeof previous.meta === 'object'
    ? mergeScanMeta(emptyScanMeta(), previous.meta)
    : emptyScanMeta();

  while (offset < file.size) {
    let end = Math.min(file.size, offset + READ_CHUNK_BYTES);
    let bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
    let newline = lastNewlineIndex(bytes);

    // 一条记录可能大于常规块大小；继续扩展到完整换行，避免拆开 JSON。
    while (newline < 0 && end < file.size) {
      end = Math.min(file.size, end + READ_CHUNK_BYTES);
      bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
      newline = lastNewlineIndex(bytes);
    }

    // 文件末尾尚未写完的行留到下次扫描，不推进 offset。
    if (newline < 0) break;
    const complete = bytes.subarray(0, newline + 1);
    usageRecords += parseUsageLines(new TextDecoder().decode(complete), daily, hourly, isSubagent, meta);
    offset += complete.byteLength;
    onBytesProcessed?.(complete.byteLength);
  }

  return {
    size: file.size,
    lastModified: file.lastModified,
    offset,
    usageRecords,
    daily: KimiMetrics.pruneDailyUsage(daily),
    hourly: KimiMetrics.pruneHourlyUsage(hourly),
    meta
  };
}

async function listWireFiles(sessionsHandle) {
  const files = [];
  for await (const [workspaceName, workspaceHandle] of sessionsHandle.entries()) {
    if (workspaceHandle.kind !== 'directory') continue;
    // 权限/句柄类失败直接向上抛出，避免返回空数组导致背景误清空历史数据。
    // 缺失 agents 目录或 wire.jsonl 是正常情况，内部 catch 跳过。
    for await (const [sessionName, sessionHandle] of workspaceHandle.entries()) {
      if (sessionHandle.kind !== 'directory' || !isSessionDirName(sessionName)) continue;
      let agentsHandle;
      try {
        agentsHandle = await sessionHandle.getDirectoryHandle('agents');
      } catch (error) {
        continue;
      }
      for await (const [agentName, agentHandle] of agentsHandle.entries()) {
        if (agentHandle.kind !== 'directory') continue;
        try {
          const wireHandle = await agentHandle.getFileHandle('wire.jsonl');
          files.push({
            path: wirePathOf(workspaceName, sessionName, agentName),
            handle: wireHandle,
            isSubagent: isSubagentAgentName(agentName)
          });
        } catch (error) {
          // 尚未生成 wire.jsonl 的代理跳过。
        }
      }
    }
  }
  return files;
}

function combineFileDaily(files) {
  let combined = {};
  for (const entry of Object.values(files || {})) {
    for (const [key, source] of Object.entries(entry?.daily || {})) {
      const bucket = { ...emptyBucket(), ...(combined[key] || {}) };
      addBucket(bucket, source);
      if (source?.sub) {
        const sub = { ...emptyBucket(), ...(bucket.sub || {}) };
        addBucket(sub, source.sub);
        bucket.sub = sub;
      }
      combined[key] = bucket;
    }
  }
  combined = KimiMetrics.pruneDailyUsage(combined);
  return combined;
}

// 逐文件按小时聚合的合流，与 combineFileDaily 同口径（含 sub 子桶）
function combineFileHourly(files) {
  let combined = {};
  for (const entry of Object.values(files || {})) {
    for (const [key, source] of Object.entries(entry?.hourly || {})) {
      const bucket = { ...emptyBucket(), ...(combined[key] || {}) };
      addBucket(bucket, source);
      if (source?.sub) {
        const sub = { ...emptyBucket(), ...(bucket.sub || {}) };
        addBucket(sub, source.sub);
        bucket.sub = sub;
      }
      combined[key] = bucket;
    }
  }
  combined = KimiMetrics.pruneHourlyUsage(combined);
  return combined;
}

// 由逐文件索引合并出按会话汇总（纯内存计算，零额外 IO）：
// 面板刷新/切会话时用它做本地恢复底数。
// agents 按「代理目录 × 模型」拆分：同一个代理中途换过模型就是多行，同一个模型
// 的多个子代理各占一行（键是代理目录名，如 main / agent-1）——一律不合并，合并了
// 就答不出「这段用量是哪个子代理、用的哪个模型」。用量按模型桶相加，与日桶同口径。
function summarizeSessions(files) {
  const sessions = {};
  const lastDay = {};
  for (const [path, entry] of Object.entries(files || {})) {
    const parsed = parseWirePath(path);
    if (!parsed) continue;
    const { sessionId: sid, agentName } = parsed;
    const total = sessions[sid] || (sessions[sid] = { ...emptyBucket(), agents: {} });
    for (const [day, source] of Object.entries(entry?.daily || {})) {
      addBucket(total, source);
      if (!lastDay[sid] || day > lastDay[sid]) lastDay[sid] = day;
    }
    const meta = entry?.meta || null;
    const agent = total.agents[agentName] || (total.agents[agentName] = {
      models: {}, firstAt: null, lastAt: null, modelAlias: null
    });
    // 子代理记录的模型名是 `__secondary__` 占位符，用该代理自己的 config.update
    // 真名归一（真名在文件末尾出现也没关系：meta 读完后才在这里落键）
    const alias = typeof meta?.modelAlias === 'string' ? meta.modelAlias : '';
    KimiMetrics.mergeModelUsage(
      agent.models,
      meta?.models,
      (model) => KimiMetrics.modelKeyOf(model, alias)
    );
    if (meta?.firstAt != null && (agent.firstAt == null || meta.firstAt < agent.firstAt)) {
      agent.firstAt = meta.firstAt;
    }
    if (meta?.lastAt != null && (agent.lastAt == null || meta.lastAt > agent.lastAt)) {
      agent.lastAt = meta.lastAt;
    }
    if (alias) agent.modelAlias = alias;
  }
  // sessions[sid].input/output/cacheRead 是全部代理合计，与 Σ(agents × models) 相等
  const ids = Object.keys(sessions);
  if (ids.length > SESSIONS_SUMMARY_LIMIT) {
    ids.sort((a, b) => (lastDay[b] || '').localeCompare(lastDay[a] || ''));
    for (const id of ids.slice(SESSIONS_SUMMARY_LIMIT)) delete sessions[id];
  }
  return sessions;
}

// 授权目录兼容两种：~/.kimi-code（可顺带读 config.toml 解析次级模型真名）
// 或其 sessions 子目录（旧版授权方式）
async function resolveSessionsHandle(handle) {
  if (handle?.name === '.kimi-code') {
    return handle.getDirectoryHandle('sessions');
  }
  return handle;
}

// 从 ~/.kimi-code/config.toml 提取 [secondary_model] 的 model 字段；
// 仅在授权了 .kimi-code 根目录时可用，其余情况返回空串
async function readSecondaryModelAlias(handle) {
  if (handle?.name !== '.kimi-code') return '';
  try {
    const fileHandle = await handle.getFileHandle('config.toml');
    const text = await (await fileHandle.getFile()).text();
    const match = text.match(/\[secondary_model\][\s\S]*?model\s*=\s*"([^"]+)"/);
    return match ? match[1] : '';
  } catch (error) {
    return '';
  }
}

async function scanSessionsDirectory(sessionsHandle, previousIndex, onProgress) {
  const rootHandle = await resolveSessionsHandle(sessionsHandle);
  const secondaryModel = await readSecondaryModelAlias(sessionsHandle);
  const previousFiles =
    previousIndex?.version === INDEX_VERSION && previousIndex.files
      ? previousIndex.files
      : {};
  const wireFiles = await listWireFiles(rootHandle);
  const preparedFiles = [];
  const files = {};
  // 单个文件失败（网络盘断连、文件锁、权限抖动）记录并跳过，不中断整次扫描
  const failures = [];
  let totalBytes = 0;
  for (const entry of wireFiles) {
    let file;
    try {
      file = await entry.handle.getFile();
    } catch (error) {
      failures.push(`${entry.path}：${error?.message || error}`);
      // 读取失败时保留旧索引并打标，避免下次 unchanged 短路永远跳过该文件
      if (previousFiles[entry.path]) {
        files[entry.path] = { ...previousFiles[entry.path], failed: true };
      }
      continue;
    }
    const previous = previousFiles[entry.path];
    const unchanged = Boolean(
      previous &&
      !previous.failed &&
      Number(previous.size) === file.size &&
      Number(previous.lastModified) === file.lastModified &&
      Number(previous.offset) === file.size
    );
    if (!unchanged) totalBytes += Math.max(0, file.size - scanStartOffset(file, previous));
    preparedFiles.push({ ...entry, file, previous, unchanged });
  }

  let processedBytes = 0;
  const reportProgress = (forceComplete = false) => {
    const percent = forceComplete || totalBytes === 0
      ? 100
      : Math.max(0, Math.min(99, Math.floor((processedBytes / totalBytes) * 100)));
    onProgress?.(percent);
  };
  reportProgress();

  let changedFiles = 0;

  for (const entry of preparedFiles) {
    if (entry.unchanged) {
      files[entry.path] = entry.previous;
      continue;
    }
    try {
      files[entry.path] = await scanFile(entry.file, entry.previous, (bytes) => {
        processedBytes += bytes;
        reportProgress();
      }, entry.isSubagent === true);
      changedFiles += 1;
    } catch (error) {
      // 读取中途失败：保留旧索引并打标，下次扫描不再被 unchanged 短路
      if (entry.previous) files[entry.path] = { ...entry.previous, failed: true };
      failures.push(`${entry.path}：${error?.message || error}`);
    }
  }
  reportProgress(true);

  const scannedAt = new Date().toISOString();
  const index = { version: INDEX_VERSION, scannedAt, files };
  return {
    index,
    daily: combineFileDaily(files),
    hourly: combineFileHourly(files),
    sessions: summarizeSessions(files),
    secondaryModel,
    scannedAt,
    fileCount: wireFiles.length,
    changedFiles,
    skippedFiles: failures.length,
    firstError: failures[0] || ''
  };
}

const KimiCliUsage = {
  DAILY_STORAGE_KEY,
  HOURLY_STORAGE_KEY,
  INDEX_STORAGE_KEY,
  STATE_STORAGE_KEY,
  SESSIONS_STORAGE_KEY,
  SECONDARY_MODEL_STORAGE_KEY,
  clearDirectoryHandle,
  combineFileDaily,
  combineFileHourly,
  emptyScanMeta,
  getDirectoryHandle,
  INDEX_VERSION,
  parseUsageLines,
  permissionState,
  saveDirectoryHandle,
  scanFile,
  scanSessionsDirectory,
  summarizeSessions
};

export {
  DAILY_STORAGE_KEY,
  HOURLY_STORAGE_KEY,
  INDEX_STORAGE_KEY,
  STATE_STORAGE_KEY,
  SESSIONS_STORAGE_KEY,
  SECONDARY_MODEL_STORAGE_KEY,
  clearDirectoryHandle,
  combineFileDaily,
  combineFileHourly,
  emptyScanMeta,
  getDirectoryHandle,
  INDEX_VERSION,
  parseUsageLines,
  permissionState,
  saveDirectoryHandle,
  scanFile,
  scanSessionsDirectory,
  summarizeSessions,
  KimiCliUsage
};
