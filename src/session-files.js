/**
 * 本地会话目录的布局规则（唯一真源）
 *
 * 目录约定：<sessions>/<workspace>/<session_*>/agents/<agent>/wire.jsonl
 *
 * 两侧各有一套遍历实现——扩展侧 cli-usage.js 走 File System Access 句柄，
 * 安装器侧 panel-app/patch/scan.mjs 走 fs——但「什么算一个会话目录、什么
 * 算子代理、wire.jsonl 的相对路径长什么样」这套命名规则必须一致：两边
 * 各写一份迟早漂移（统计口径、子代理分桶都会跟着歪），收在这里。
 */

const SESSION_PREFIX = 'session_';
const MAIN_AGENT = 'main';

/** 会话目录名（workspace 下只认 session_ 开头的目录） */
export function isSessionDirName(name) {
  return String(name).startsWith(SESSION_PREFIX);
}

/** agents/main 是主代理，其余（agent-N 等）按子代理分桶 */
export function isSubagentAgentName(name) {
  return String(name) !== MAIN_AGENT;
}

/** 会话目录内的 wire.jsonl 相对路径（跨会话汇总的键） */
export function wirePathOf(workspace, session, agent) {
  return `${workspace}/${session}/agents/${agent}/wire.jsonl`;
}

const WIRE_PATH_RE = /^[^/]+\/(session_[^/]+)\/agents\/([^/]+)\/wire\.jsonl$/;

/** 反解 wire.jsonl 的相对路径；不符合约定的返回 null */
export function parseWirePath(path) {
  const match = WIRE_PATH_RE.exec(String(path));
  if (!match) return null;
  return { sessionId: match[1], agentName: match[2] };
}
