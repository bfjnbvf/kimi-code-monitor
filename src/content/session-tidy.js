/* 自动整理「已完成」：内容脚本执行器（本机/LAN/RC 页面）。
 *
 * 职责：拉取「进行中」会话列表（/api/v2/sessions）、跑 tidy-rules 判定、
 * 批量归档（/api/v2/sessions:archive）、实验性「多标签页侧栏」开关联动。
 * 阈值/模式设置由 popup 写 chrome.storage.local（kimiTidySettings），这里只读。
 * 消息入口：background 中继（popup 发起）与后台 alarm（自动模式），本模块
 * 不主动发起任何动作。
 */
'use strict';

import { t } from '../i18n.js';
import * as TidyRules from '../tidy-rules.js';
import { rcApiPrefix, localApiAuthHeaders } from './utils.js';

const CREDENTIAL_STORAGE_KEY = 'kimi-web.server-credential';
export const TIDY_SETTINGS_STORAGE_KEY = 'kimiTidySettings';
// kimi web 实验性「多标签页侧栏」的 localStorage 键（bundle 取证：值为 "1"/"0"）
const LAB_SIDEBAR_TABS_KEY = 'kimi-web.sidebar-multi-tab';
const LIST_PAGE_SIZE = 100;
// 安全上限：200 页 × 100 条，防止异常分页循环
const MAX_LIST_PAGES = 200;

function readCredential() {
  try {
    const raw = localStorage.getItem(CREDENTIAL_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return typeof parsed?.credential === 'string' ? parsed.credential : '';
  } catch {
    return '';
  }
}

function apiHeaders() {
  return { ...localApiAuthHeaders(readCredential()), Accept: 'application/json' };
}

async function apiGet(path) {
  const response = await fetch(`${rcApiPrefix()}${path}`, {
    headers: apiHeaders(),
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function apiPost(path, body) {
  const response = await fetch(`${rcApiPrefix()}${path}`, {
    method: 'POST',
    headers: { ...apiHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json().catch(() => ({}));
}

/* 拉全部「进行中」会话（V2 平铺列表，按最后活跃倒序，游标分页）。
 * meta.archived=false 由服务端过滤；字段形态以实测为准，判定前统一走
 * normalizeTidySession（兼容 V1/V2 两种形态）。 */
async function fetchAllOpenSessions() {
  const sessions = [];
  let pageToken = '';
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const query = new URLSearchParams({
      sort: 'meta.updated_at_desc',
      'meta.archived': 'false',
      page_size: String(LIST_PAGE_SIZE)
    });
    if (pageToken) query.set('page_token', pageToken);
    const body = await apiGet(`/api/v2/sessions?${query.toString()}`);
    // 实测（本机 58627）：返回 { code, msg, data: { items, next_page_token } }，
    // items 在 data 里；兼容无 data 包装的旧形态
    const payload = body?.data && typeof body.data === 'object' ? body.data : body;
    const items = Array.isArray(payload?.items) ? payload.items : [];
    sessions.push(...items);
    pageToken = typeof payload?.next_page_token === 'string' && payload.next_page_token
      ? payload.next_page_token
      : '';
    if (!pageToken) break;
  }
  return sessions;
}

async function loadTidySettings() {
  const stored = await chrome.storage.local.get(TIDY_SETTINGS_STORAGE_KEY);
  return {
    ...TidyRules.defaultTidyThresholds(),
    ...(stored[TIDY_SETTINGS_STORAGE_KEY] && typeof stored[TIDY_SETTINGS_STORAGE_KEY] === 'object'
      ? stored[TIDY_SETTINGS_STORAGE_KEY]
      : {})
  };
}

async function computeTidyCandidates() {
  const [sessions, settings] = await Promise.all([fetchAllOpenSessions(), loadTidySettings()]);
  const { candidates } = TidyRules.classifyTidyCandidates(sessions, Date.now(), settings);
  return { ok: true, candidates, scanned: sessions.length };
}

async function applyTidyArchive(payload) {
  const ids = Array.isArray(payload?.ids)
    ? payload.ids.filter((id) => typeof id === 'string' && id).slice(0, 500)
    : [];
  if (!ids.length) return { ok: false, error: '没有可归档的会话' };
  await apiPost('/api/v2/sessions:archive', { ids });
  return { ok: true, archived: ids.length };
}

/* 实验性「多标签页侧栏」联动：仅在用户打开自动整理开关时调用一次。
 * 已开启则不动；未开启写入后提示并整页刷新（web 启动时读一次内存，
 * 外部改 localStorage 不热生效）。用户事后自行关闭不回写（无拉锯）。 */
async function ensureLabSidebarTabs() {
  let enabled;
  try {
    enabled = localStorage.getItem(LAB_SIDEBAR_TABS_KEY) === '1';
  } catch {
    return { ok: false, error: 'localStorage 不可用' };
  }
  if (enabled) return { ok: true, changed: false };
  try {
    localStorage.setItem(LAB_SIDEBAR_TABS_KEY, '1');
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
  showLabNotice();
  // 留出 sendResponse 往返时间再刷新
  setTimeout(() => location.reload(), 1_500);
  return { ok: true, changed: true, reloading: true };
}

function showLabNotice() {
  if (document.getElementById('ksb-tidy-lab-notice')) return;
  const notice = document.createElement('div');
  notice.id = 'ksb-tidy-lab-notice';
  notice.textContent = t('已开启实验性「多标签页侧栏」，页面即将刷新以生效…');
  notice.style.cssText =
    'position:fixed;left:50%;bottom:72px;transform:translateX(-50%);z-index:2147483647;' +
    'background:#1f2329;color:#fff;padding:10px 18px;border-radius:10px;font-size:13px;' +
    'box-shadow:0 6px 24px rgba(0,0,0,.25);';
  document.body.append(notice);
}

async function runTidyAuto() {
  const { candidates, scanned } = await computeTidyCandidates();
  if (!candidates.length) return { ok: true, archived: 0, scanned };
  const ids = candidates.map((candidate) => candidate.id);
  await apiPost('/api/v2/sessions:archive', { ids });
  return { ok: true, archived: ids.length, scanned };
}

function handleRuntimeMessage(message, _sender, sendResponse) {
  const handlers = {
    'tidy.candidates.fetch': computeTidyCandidates,
    'tidy.apply': () => applyTidyArchive(message.payload),
    'tidy.lab.ensure': ensureLabSidebarTabs,
    'tidy.auto.run': runTidyAuto,
    // 官方自动命名实验（auto_session_title）是否已启用：popup 据此隐藏/显示
    // 「新会话自动命名」引导子块。权威来源 /api/v1/meta 的 experimental_flags
    //（环境变量主开关），config.experimental 为配置文件路径的兜底。
    'rename.official.status.fetch': async () => {
      const meta = await apiGet('/api/v1/meta').catch(() => null);
      const flags = meta?.experimental_flags ?? meta?.data?.experimental_flags;
      if (flags && typeof flags === 'object') {
        return { ok: true, enabled: flags.auto_session_title === true };
      }
      const config = await apiGet('/api/v1/config').catch(() => null);
      const data = config?.data && typeof config.data === 'object' ? config.data : config;
      const experimental = data?.experimental && typeof data.experimental === 'object' ? data.experimental : {};
      return { ok: true, enabled: experimental.auto_session_title === true };
    }
  };
  const handler = handlers[message?.type];
  if (!handler) return false;
  handler()
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
}

export function initSessionTidy() {
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
}
