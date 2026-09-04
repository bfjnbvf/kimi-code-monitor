/* 会话智能命名：内容脚本管线（本机/LAN/Remote Control 页面）。
 * 职责：读 localStorage 凭据、守卫（手动标题保护/去重/并发锁）、触发与记录。
 * v3.4.0 起执行端改为系统「生成标题」：POST /api/v1/sessions/{id}/title/generate
 * （服务端生成并写回，与右键菜单同一通路，需登录 Kimi Code 托管账号）。
 * 扩展自己的模型调用管线（取样→组 prompt→rename.model）整体注释保留，
 * 恢复方法见 docs/DESIGN-extensions-card.md §3.2。
 * 触发入口：content.js 在 turn.ended 后 import { onTurnEnded } 直接调用，
 * 第 3 轮对话结束后命名（首轮内容太少不足以概括）。 */
'use strict';

import * as shared from './rename-shared.js';
import { rcApiPrefix, localApiAuthHeaders } from '../content/utils.js';

const CREDENTIAL_STORAGE_KEY = 'kimi-web.server-credential';
const RENAME_LOG_STORAGE_KEY = 'sessionRenameLog';
const SETTINGS_STORAGE_KEY = 'sessionRenameSettings';
const AUTO_TRIGGER_DELAY_MS = 3_000;
const MAX_ATTEMPTS_PER_SESSION = 3;
// 暂时性跳过原因：不消耗尝试次数，后续轮次结束可再触发
// （busy：轮末 3 秒内用户已发下一条；locked：他页持锁但自己可能失败）
const RETRYABLE_SKIP_REASONS = new Set(['busy', 'locked']);
// 第 3 轮对话结束后才自动命名：首轮内容太少不足以概括
const AUTO_RENAME_MIN_TURNS = 3;
// v2 只关心总开关；emoji/模型选择随旧管线停用（存储里的旧字段原样保留不读）
const DEFAULT_SETTINGS = { autoEnabled: false };
// 多标签并发锁：防止多开标签重复命名同一会话、重复调模型 API
const RENAME_LOCK_PREFIX = 'sessionRename.lock.';
const RENAME_LOCK_TTL_MS = 120_000;

let settings = { ...DEFAULT_SETTINGS };
// 同一 sessionId 页面内去重；attempts 记录失败次数（首轮可能全是工具调用没有文本）
const triggeredThisPage = new Set();
const attemptCounts = new Map();

/* ---------- 凭据与本地 REST ---------- */

function readCredential() {
  try {
    const raw = localStorage.getItem(CREDENTIAL_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return typeof parsed?.credential === 'string' ? parsed.credential : '';
  } catch (error) {
    return '';
  }
}

async function apiGet(path) {
  // RC 页面需带 /devices/<id> 前缀；空凭据时不发 Authorization（中继回源注入）
  const response = await fetch(`${rcApiPrefix()}${path}`, {
    headers: localApiAuthHeaders(readCredential()),
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/* v2 停用：旧管线的手动写回标题（系统 title/generate 由服务端写回）。
async function writeTitle(sessionId, title) {
  const response = await fetch(`${rcApiPrefix()}/api/v1/sessions/${encodeURIComponent(sessionId)}/profile`, {
    method: 'POST',
    headers: {
      ...localApiAuthHeaders(readCredential()),
      'content-type': 'application/json'
    },
    body: JSON.stringify({ title }),
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}
*/

async function fetchSession(sessionId) {
  const body = await apiGet(`/api/v1/sessions/${encodeURIComponent(sessionId)}`);
  return body?.data && typeof body.data === 'object' ? body.data : body;
}

/* v2 停用：旧管线的消息取样（上下文组装不再需要）。
async function fetchMessages(sessionId) {
  const body = await apiGet(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages?page_size=20`
  );
  const items = Array.isArray(body?.data?.items) ? body.data.items : [];
  // 接口按新→旧返回，翻转为时间正序（尾部取样依赖最后一条是最新消息）
  return items.slice().reverse();
}
*/

/* 拉真实首条 user 消息：role=user 过滤后从新→旧逐页回翻（before_id 用页内最旧
 * 消息的真实 id），user 消息比全部消息稀疏得多，绝大多数会话 1~2 页到底。
 * 合成序号锚点不可依赖（锚点不存在时接口静默回退到最新页），故不用。
 * 超过 8 页（800 条 user 消息）保守放弃返回 ''，启发式按跳过处理。 */
async function fetchFirstUserText(sessionId) {
  let before = null;
  for (let page = 0; page < 8; page += 1) {
    const query = `role=user&page_size=100${before ? `&before_id=${encodeURIComponent(before)}` : ''}`;
    const body = await apiGet(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages?${query}`
    );
    const items = Array.isArray(body?.data?.items) ? body.data.items : [];
    if (!items.length) return '';
    if (!body?.data?.has_more) {
      for (let index = items.length - 1; index >= 0; index -= 1) {
        const text = shared.messageText(items[index]);
        if (text) return text;
      }
      return '';
    }
    before = items[items.length - 1].id;
  }
  return '';
}

/* v2 执行端：调用系统「生成标题」，服务端生成并写回。
 * 返回标题文本（接口未回传标题时为空串，仅作记录）；失败抛错由调用方计次。
 * 前置条件随系统：需登录 Kimi Code 托管账号、会话中已有消息（客户端文案
 * genTitleUnavailable 同款语义），失败走静默计次，不弹错误。 */
async function callSystemTitleGenerate(sessionId) {
  const response = await fetch(`${rcApiPrefix()}/api/v1/sessions/${encodeURIComponent(sessionId)}/title/generate`, {
    method: 'POST',
    headers: localApiAuthHeaders(readCredential()),
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json().catch(() => ({}));
  const data = body?.data && typeof body.data === 'object' ? body.data : body;
  const title = typeof data?.title === 'string' ? data.title : (typeof data === 'string' ? data : '');
  return title;
}

/* 轮数判断：会话详情的 usage.turn_count 恒为 0 不可用；page_size 按轮次分页，
 * role=user&page_size=100 返回最近约 100 轮里的 user 消息，条数即轮数的近似。
 * ≥3 条说明至少进行了 3 轮对话。 */
async function hasEnoughTurns(sessionId) {
  const body = await apiGet(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages?role=user&page_size=100`
  );
  const items = Array.isArray(body?.data?.items) ? body.data.items : [];
  return items.length >= AUTO_RENAME_MIN_TURNS;
}

/* ---------- 命名记录与设置 ---------- */

async function readRenameLog() {
  const stored = await chrome.storage.local.get(RENAME_LOG_STORAGE_KEY);
  const log = stored[RENAME_LOG_STORAGE_KEY];
  return log && typeof log === 'object' ? log : {};
}

async function recordRename(sessionId, title) {
  const log = await readRenameLog();
  log[sessionId] = { title, renamedAt: Date.now() };
  await chrome.storage.local.set({ [RENAME_LOG_STORAGE_KEY]: log });
}

/* ---------- 多标签并发锁 ----------
 * 以 chrome.storage.local 为分布式锁，键含 sessionId，TTL 2 分钟。
 * read-check-write 在极端竞态下可能双写，由 recordRename 的 already-renamed
 * 检查把重复命名概率降到可忽略。 */
function renameLockKey(sessionId) {
  return `${RENAME_LOCK_PREFIX}${sessionId}`;
}

async function acquireRenameLock(sessionId) {
  const key = renameLockKey(sessionId);
  const stored = await chrome.storage.local.get(key);
  const existing = stored[key];
  if (existing && typeof existing === 'object' && Number.isFinite(existing.startedAt)) {
    if (Date.now() - existing.startedAt < RENAME_LOCK_TTL_MS) return false;
  }
  await chrome.storage.local.set({ [key]: { startedAt: Date.now() } });
  return true;
}

async function releaseRenameLock(sessionId) {
  await chrome.storage.local.remove(renameLockKey(sessionId)).catch(() => {});
}

/* ---------- 核心管线 ----------
 * 返回 { status: 'renamed'|'skipped'|'failed', reason, title? } */
async function renameOneSession(session) {
  if (!(await acquireRenameLock(session.id))) {
    return { status: 'skipped', reason: 'locked' };
  }
  try {
    const renameLog = await readRenameLog();
    const reason = shared.skipSessionReason(session, { renameLog });
    if (reason) return { status: 'skipped', reason };

    // 真实首条消息用于手动标题启发式（宁漏勿错）。拉不到时启发式按保守方向跳过。
    const firstUserText = await fetchFirstUserText(session.id).catch(() => '');
    if (!shared.looksLikeAutoTitle(session.title, firstUserText)) {
      return { status: 'skipped', reason: 'custom-title' };
    }

    // v2：调系统「生成标题」，服务端生成并写回；标题仅用于本地命名记录。
    // —— v3.3.x 旧管线（取样 → 组 prompt → rename.model → 写回）注释保留：
    // const messages = await fetchMessages(session.id);
    // const context = shared.buildRenameContext(messages, { firstUserText });
    // if (!context.text) return { status: 'skipped', reason: 'empty' };
    // const prompt = shared.buildRenamePrompt(context.text, { withEmoji });
    // const response = await chrome.runtime.sendMessage({
    //   type: 'rename.model',
    //   payload: { modelSource, prompt }
    // });
    // if (!response?.ok) return { status: 'failed', reason: response?.error || '模型调用失败' };
    // const title = shared.sanitizeTitle(response.text, { withEmoji });
    // if (!title) return { status: 'failed', reason: '模型输出无法解析为标题' };
    // await writeTitle(session.id, title);

    const title = await callSystemTitleGenerate(session.id);
    await recordRename(session.id, title);
    return { status: 'renamed', title };
  } finally {
    await releaseRenameLock(session.id);
  }
}

/* ---------- 自动模式：第 3 轮回答结束后延迟命名，失败静默 ---------- */

function onTurnEnded(sessionId) {
  if (!settings.autoEnabled || !sessionId) return;
  if (triggeredThisPage.has(sessionId)) return;
  if ((attemptCounts.get(sessionId) || 0) >= MAX_ATTEMPTS_PER_SESSION) return;
  triggeredThisPage.add(sessionId);
  // 等 title 落定（服务端在轮末才生成自动标题）
  setTimeout(() => autoRename(sessionId), AUTO_TRIGGER_DELAY_MS);
}

async function autoRename(sessionId) {
  try {
    const renameLog = await readRenameLog();
    if (renameLog[sessionId]) return;
    const session = await fetchSession(sessionId);
    if (!session?.id) return;
    // 轮数不足（< 3）：放回触发集合，等后续轮次结束再试，不消耗尝试次数
    const enoughTurns = await hasEnoughTurns(sessionId).catch(() => false);
    if (!enoughTurns) {
      triggeredThisPage.delete(sessionId);
      return;
    }
    const result = await renameOneSession(session);
    if (result.status === 'renamed') {
      attemptCounts.delete(sessionId);
    } else if (result.status === 'failed') {
      // 失败（可能全是工具调用没有文本）：放回去重集合，
      // 后续轮次结束可再触发，直到 MAX_ATTEMPTS_PER_SESSION 次
      attemptCounts.set(sessionId, (attemptCounts.get(sessionId) || 0) + 1);
      triggeredThisPage.delete(sessionId);
    } else if (result.status === 'skipped' && RETRYABLE_SKIP_REASONS.has(result.reason)) {
      // 暂时性跳过：放回去重集合但不消耗尝试次数
      triggeredThisPage.delete(sessionId);
    }
  } catch (error) {
    attemptCounts.set(sessionId, (attemptCounts.get(sessionId) || 0) + 1);
    triggeredThisPage.delete(sessionId);
    console.warn('[Kimi Status] 自动命名失败（已静默）', error);
  }
}

/* v2 停用：Kimi Code 内置模型清单拉取（旧管线的选择模型功能已移除）。
async function fetchKimiCodeModels() {
  const body = await apiGet('/api/v1/models');
  return shared.kimiCodeModelsFromResponse(body?.data?.items);
}
*/

/* ---------- 接线 ---------- */

/* v2 停用：popup 模型下拉的中继拉取（popup 不再展示模型选择）。
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'rename.models.fetch') {
    fetchKimiCodeModels()
      .then((models) => sendResponse({ ok: true, models }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  return false;
});
*/

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[SETTINGS_STORAGE_KEY]) return;
  settings = { ...DEFAULT_SETTINGS, ...(changes[SETTINGS_STORAGE_KEY].newValue || {}) };
});

chrome.storage.local.get(SETTINGS_STORAGE_KEY).then((stored) => {
  settings = { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_STORAGE_KEY] || {}) };
});

// content.js 的 turn.ended 钩子直接 import onTurnEnded 调用。

export {
  CREDENTIAL_STORAGE_KEY,
  RENAME_LOG_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  AUTO_TRIGGER_DELAY_MS,
  MAX_ATTEMPTS_PER_SESSION,
  RETRYABLE_SKIP_REASONS,
  AUTO_RENAME_MIN_TURNS,
  DEFAULT_SETTINGS,
  RENAME_LOCK_PREFIX,
  RENAME_LOCK_TTL_MS,
  readCredential,
  apiGet,
  fetchSession,
  fetchFirstUserText,
  hasEnoughTurns,
  callSystemTitleGenerate,
  readRenameLog,
  recordRename,
  renameLockKey,
  acquireRenameLock,
  releaseRenameLock,
  renameOneSession,
  onTurnEnded,
  autoRename
};
