/**
 * 扩展功能板块：自动归档不活跃对话（一次性首跑流程）+ AI 回复收藏开关。
 *
 * 生命周期：开启功能即自动 dry run——就地显示待归档条数与「清理并解锁
 * 自动归档」按钮，点击归档全部候选并进入自动阶段（每 24 小时后台归档），
 * 该面板从此消失，配置区只剩阈值行。零候选时显示「没有符合条件的对话」
 * 与「点击解锁自动归档」。没有模式下拉，想退出就关闭整个功能。
 * 解锁键 kimiTidyManualDoneAt 同时是后台 alarm 的启动条件；解锁时写
 * kimiTidyLastRun，让首次自动归档从 24 小时后开始（不立即清扫用户刻意
 * 留下的对话）。开启功能时联动 Kimi Web 实验性「多标签页侧栏」。
 */
import { send, pageState } from './shared.js';
import { t } from '../i18n.js';

const TIDY_SETTINGS_STORAGE_KEY = 'kimiTidySettings';
const TIDY_MANUAL_DONE_STORAGE_KEY = 'kimiTidyManualDoneAt';
const TIDY_LAST_RUN_STORAGE_KEY = 'kimiTidyLastRun';
const BOOKMARKS_FEATURE_STORAGE_KEY = 'kimiFeatureBookmarks';

// 阈值键名与 tidy-rules 的阈值字段一致
const DEFAULT_TIDY_SETTINGS = {
  enabled: false,
  singleDayEnabled: true,
  multiDayEnabled: true,
  allEnabled: true,
  singleDayIdleDays: 3,
  multiDayIdleDays: 14,
  allIdleDays: 30
};

const tidyToggle = document.getElementById('tidy-toggle');
const extTidyBlock = document.getElementById('ext-tidy-block');
const tidyFirstRun = document.getElementById('tidy-candidates');
// 三档规则的启停勾选框（键名与设置字段一致）
const ruleChecks = {
  singleDayEnabled: document.getElementById('tidy-rule-single'),
  multiDayEnabled: document.getElementById('tidy-rule-multi'),
  allEnabled: document.getElementById('tidy-rule-all')
};
// 阈值输入按档位顺序对应规则键名
const thresholdInputs = {
  singleDayIdleDays: document.getElementById('tidy-t1'),
  multiDayIdleDays: document.getElementById('tidy-t2'),
  allIdleDays: document.getElementById('tidy-t3')
};
const tidyHint = document.getElementById('tidy-hint');
const bookmarksToggle = document.getElementById('bookmarks-toggle');
const extBookmarksBlock = document.getElementById('ext-bookmarks-block');

let tidySettings = { ...DEFAULT_TIDY_SETTINGS };

function saveTidySettings() {
  chrome.storage.local.set({ [TIDY_SETTINGS_STORAGE_KEY]: { ...tidySettings } }).catch(() => {});
}

// 设置落库后通知后台校准自动归档 alarm（解锁/开关变化都会走到这里）
async function notifySettingsUpdated() {
  try { await send('tidy.settings.updated'); } catch { /* 页面未开等场景静默 */ }
}

function renderTidy(on) {
  tidyToggle.checked = on;
  extTidyBlock.classList.toggle('on', on);
}

function renderRuleChecks() {
  for (const key of Object.keys(ruleChecks)) {
    ruleChecks[key].checked = tidySettings[key] !== false;
    const row = ruleChecks[key].closest('.tidy-row');
    if (row) {
      row.classList.toggle('off', !ruleChecks[key].checked);
      const numberInput = row.querySelector('input[type="number"]');
      if (numberInput) numberInput.disabled = !ruleChecks[key].checked;
    }
  }
}

function renderThresholds() {
  for (const key of Object.keys(thresholdInputs)) {
    thresholdInputs[key].value = tidySettings[key];
  }
}

function clampThreshold(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return null;
  return Math.min(365, Math.max(1, number));
}

async function isUnlocked() {
  try {
    const stored = await chrome.storage.local.get(TIDY_MANUAL_DONE_STORAGE_KEY);
    return Number(stored[TIDY_MANUAL_DONE_STORAGE_KEY]) > 0;
  } catch {
    return false;
  }
}

// 阶段提示：自动阶段汇报节奏与上次结果；手动阶段的信息由首跑面板承载
async function renderTidyPhase() {
  const unlocked = await isUnlocked();
  if (!unlocked) {
    tidyHint.hidden = true;
    tidyHint.textContent = '';
    return;
  }
  tidyHint.textContent = t('每 24 小时后台自动归档一次');
  try {
    const stored = await chrome.storage.local.get(TIDY_LAST_RUN_STORAGE_KEY);
    const lastRun = stored[TIDY_LAST_RUN_STORAGE_KEY];
    if (lastRun?.at) {
      const time = new Date(lastRun.at).toLocaleString();
      tidyHint.textContent = t('每 24 小时后台自动归档一次；上次：{time}，归档 {n} 个对话',
        { time, n: Number(lastRun.archived) || 0 });
    }
  } catch { /* 读失败保持基础文案 */ }
  tidyHint.hidden = false;
}

/* ---------- 首跑面板（一次性）：dry run 条数 + 清理并解锁 ---------- */

function hideFirstRunPanel() {
  tidyFirstRun.classList.add('hidden');
  tidyFirstRun.replaceChildren();
}

function renderFirstRunPanel(candidates) {
  tidyFirstRun.replaceChildren();
  const count = document.createElement('div');
  count.className = 'tidy-hint';
  count.textContent = candidates?.length
    ? t('有 {n} 条对话待归档', { n: candidates.length })
    : t('没有符合条件的对话');
  tidyFirstRun.append(count);
  // 列出具体会话名，让用户在点击前知道要归档的是什么；最多 8 条，其余折入省略行
  const shown = (candidates || []).slice(0, 8);
  if (shown.length) {
    const list = document.createElement('div');
    list.className = 'tidy-first-list';
    for (const candidate of shown) {
      const item = document.createElement('div');
      item.className = 'tidy-first-item';
      const title = candidate.title || t('未命名会话');
      item.textContent = title;
      item.title = `${title} · ${t('静默 {days} 天', { days: candidate.idleDays })}`;
      list.append(item);
    }
    const rest = candidates.length - shown.length;
    if (rest > 0) {
      const more = document.createElement('div');
      more.className = 'tidy-first-item tidy-first-more';
      more.textContent = t('……以及其他 {m} 个对话', { m: rest });
      list.append(more);
    }
    tidyFirstRun.append(list);
  }
  const actionBtn = document.createElement('button');
  actionBtn.type = 'button';
  actionBtn.className = 'action tidy-unlock-btn';
  actionBtn.textContent = candidates?.length
    ? t('清理并解锁自动归档')
    : t('点击解锁自动归档');
  actionBtn.addEventListener('click', async () => {
    actionBtn.disabled = true;
    try {
      let archived = 0;
      if (candidates?.length) {
        const response = await send('tidy.apply', { ids: candidates.map((c) => c.id) });
        if (!response?.ok) throw new Error(response?.error || t('操作失败'));
        archived = Number(response.archived) || candidates.length;
      }
      await markManualDone();
      await renderTidyPhase();
      flashHint(archived > 0
        ? t('已移入「已完成」{n} 个对话', { n: archived })
        : t('已解锁自动归档'));
    } catch (error) {
      actionBtn.disabled = false;
      flashHint(t('操作失败：{msg}', { msg: error.message || error }));
    }
  });
  tidyFirstRun.append(actionBtn);
  tidyFirstRun.classList.remove('hidden');
}

function renderFirstRunError(message) {
  tidyFirstRun.replaceChildren();
  const line = document.createElement('div');
  line.className = 'tidy-hint';
  line.textContent = t('读取失败：{msg}', { msg: message });
  tidyFirstRun.append(line);
  const retryBtn = document.createElement('button');
  retryBtn.type = 'button';
  retryBtn.className = 'action tidy-unlock-btn';
  retryBtn.textContent = t('重试');
  retryBtn.addEventListener('click', () => runFirstRunPanel());
  tidyFirstRun.append(retryBtn);
  tidyFirstRun.classList.remove('hidden');
}

// 首跑 dry run：仅在「已开启且未解锁」时拉取候选并渲染面板。
// 读取失败必须与「没有符合条件的对话」区分显示——前者要给重试出口。
async function runFirstRunPanel() {
  if (tidySettings.enabled !== true || disposedOrGone()) return;
  if (await isUnlocked()) return;
  tidyFirstRun.classList.remove('hidden');
  tidyFirstRun.replaceChildren();
  const loading = document.createElement('div');
  loading.className = 'tidy-hint';
  loading.textContent = t('正在读取会话列表…');
  tidyFirstRun.append(loading);
  let candidates = null;
  let fetchError = '';
  try {
    const response = await send('tidy.candidates');
    if (pageState.pageDestroyed) return;
    if (response?.ok) {
      candidates = response.candidates || [];
    } else {
      fetchError = response?.error || t('操作失败');
    }
  } catch (error) {
    if (pageState.pageDestroyed) return;
    fetchError = error?.message || String(error);
  }
  if (pageState.pageDestroyed) return;
  if (fetchError) {
    renderFirstRunError(fetchError);
    return;
  }
  renderFirstRunPanel(candidates || []);
}

function disposedOrGone() {
  return pageState.pageDestroyed;
}

// 解锁自动阶段：写解锁键，并记录 lastRun——首次自动归档从 24 小时后开始，
// 不立即清扫用户刻意留下的对话
async function markManualDone() {
  await chrome.storage.local.set({
    [TIDY_MANUAL_DONE_STORAGE_KEY]: Date.now(),
    [TIDY_LAST_RUN_STORAGE_KEY]: { at: Date.now(), archived: 0, scanned: 0 }
  });
  await notifySettingsUpdated();
}

// 轻反馈：hint 区短暂提示后恢复阶段文案
let hintTimer = null;
function flashHint(message) {
  clearTimeout(hintTimer);
  tidyHint.textContent = message;
  tidyHint.hidden = false;
  hintTimer = setTimeout(() => { renderTidyPhase(); }, 4_000);
}

/* ---------- 开关与阈值 ---------- */

tidyToggle.addEventListener('change', async () => {
  tidySettings.enabled = tidyToggle.checked;
  renderTidy(tidySettings.enabled);
  saveTidySettings();
  notifySettingsUpdated();
  if (tidySettings.enabled) {
    // 联动实验性「多标签页侧栏」：内容脚本写 localStorage 并刷新页面；
    // 用户事后自行关闭不回写。没有打开的 Kimi 页面时静默跳过。
    try {
      const response = await send('tidy.lab.ensure');
      if (response?.ok && response.changed) {
        tidyHint.textContent = t('已开启 Kimi Web 实验性「多标签页侧栏」，页面即将刷新…');
        tidyHint.hidden = false;
        clearTimeout(hintTimer);
        hintTimer = setTimeout(() => { renderTidyPhase(); }, 6_000);
        return;
      }
    } catch { /* 无打开页面：下次打开页面后可在设置里手动开启 */ }
    runFirstRunPanel();
  } else {
    hideFirstRunPanel();
  }
});

let thresholdSaveTimer = null;

for (const key of Object.keys(thresholdInputs)) {
  // input 即时防抖保存：改完数字立刻关弹窗也不会丢（change 只在失焦/回车触发）
  thresholdInputs[key].addEventListener('input', () => {
    const clamped = clampThreshold(thresholdInputs[key].value);
    if (clamped == null) return;
    tidySettings[key] = clamped;
    clearTimeout(thresholdSaveTimer);
    thresholdSaveTimer = setTimeout(saveTidySettings, 400);
  });
  thresholdInputs[key].addEventListener('change', () => {
    const clamped = clampThreshold(thresholdInputs[key].value);
    if (clamped == null) {
      renderThresholds();
      return;
    }
    thresholdInputs[key].value = String(clamped);
    tidySettings[key] = clamped;
    saveTidySettings();
    // 手动阶段调整阈值后重跑 dry run，让待归档条数与新阈值一致
    if (!tidyFirstRun.classList.contains('hidden')) runFirstRunPanel();
  });
}

// 三档规则勾选框：启用/停用即时保存，未勾选的行置灰且天数输入停用
for (const key of Object.keys(ruleChecks)) {
  ruleChecks[key].addEventListener('change', () => {
    tidySettings[key] = ruleChecks[key].checked;
    saveTidySettings();
    renderRuleChecks();
    if (!tidyFirstRun.classList.contains('hidden')) runFirstRunPanel();
  });
}

/* ---------- AI 回复收藏开关 ---------- */

function renderBookmarks(on) {
  bookmarksToggle.checked = on;
  extBookmarksBlock.classList.toggle('on', on);
}

let bookmarksLoaded = false;

export async function loadBookmarksFeature() {
  let enabled = true;
  try {
    const stored = await chrome.storage.local.get(BOOKMARKS_FEATURE_STORAGE_KEY);
    enabled = stored[BOOKMARKS_FEATURE_STORAGE_KEY] !== false;
  } catch { /* 读失败按默认开 */ }
  bookmarksLoaded = true;
  renderBookmarks(enabled);
}

// 防初始化竞态：存储读取完成前用户碰到开关，变更事件会把「HTML 默认值」
// 写回存储、覆盖真实偏好（表现为每次重开都跳回关闭）。未加载完时只改
// UI 不落盘，待 loadBookmarksFeature 以存储真值渲染。
bookmarksToggle.addEventListener('change', () => {
  renderBookmarks(bookmarksToggle.checked);
  if (!bookmarksLoaded) return;
  chrome.storage.local
    .set({ [BOOKMARKS_FEATURE_STORAGE_KEY]: bookmarksToggle.checked })
    .catch(() => {});
});

/* ---------- 装配 ---------- */

export async function loadTidySettings() {
  try {
    const stored = await chrome.storage.local.get(TIDY_SETTINGS_STORAGE_KEY);
    tidySettings = { ...DEFAULT_TIDY_SETTINGS, ...(stored[TIDY_SETTINGS_STORAGE_KEY] || {}) };
  } catch { /* 读失败用默认设置 */ }
  renderTidy(tidySettings.enabled === true);
  renderRuleChecks();
  renderThresholds();
  await renderTidyPhase();
  if (tidySettings.enabled) runFirstRunPanel();
}
