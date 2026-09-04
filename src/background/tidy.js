/**
 * 自动归档调度域：自动阶段的 24h alarm、节流与完成通知。
 * 判定与归档在内容脚本执行（session-tidy），这里只读设置、控节奏、发通知。
 * 自动阶段的进入条件 = 功能开关已开且已完成首次手动归档（kimiTidyManualDoneAt，
 * 由 popup 在首次整理/空结果确认时写入）；没有打开的 Kimi 页面时本轮跳过
 * 且不记 lastRun（下次 alarm 重试），与额度预警同款低功耗原则。
 */
import { relayToKimiWebTab, failure } from './store.js';

export const TIDY_AUTO_ALARM = 'kimi-tidy-auto';

const TIDY_SETTINGS_STORAGE_KEY = 'kimiTidySettings';
const TIDY_MANUAL_DONE_STORAGE_KEY = 'kimiTidyManualDoneAt';
const TIDY_LAST_RUN_STORAGE_KEY = 'kimiTidyLastRun';
const TIDY_RUN_INTERVAL_MS = 24 * 3_600_000;
// alarm 唤醒有分钟粒度，创建后 5 分钟做首次尝试（解锁时另有即时触发）
const TIDY_FIRST_DELAY_MINUTES = 5;
const TIDY_PERIOD_MINUTES = 1_440;

async function readAutoReady() {
  const stored = await chrome.storage.local.get([
    TIDY_SETTINGS_STORAGE_KEY,
    TIDY_MANUAL_DONE_STORAGE_KEY
  ]);
  return stored[TIDY_SETTINGS_STORAGE_KEY]?.enabled === true &&
    Number(stored[TIDY_MANUAL_DONE_STORAGE_KEY]) > 0;
}

// 设置变更 / SW 冷启动 / onInstalled 时对齐 alarm；未解锁或关闭即清除
export async function syncTidyAutoAlarm() {
  const shouldSchedule = await readAutoReady();
  const existing = await chrome.alarms.get(TIDY_AUTO_ALARM).catch(() => null);
  if (shouldSchedule && !existing) {
    await chrome.alarms.create(TIDY_AUTO_ALARM, {
      delayInMinutes: TIDY_FIRST_DELAY_MINUTES,
      periodInMinutes: TIDY_PERIOD_MINUTES
    });
  } else if (!shouldSchedule && existing) {
    await chrome.alarms.clear(TIDY_AUTO_ALARM);
  }
  return { ok: true, scheduled: shouldSchedule };
}

// 到点执行：24h 节流；relay 失败（无页面等）不记 lastRun，下轮重试
export async function runTidyAutoIfDue() {
  if (!(await readAutoReady())) return { ok: true, skipped: 'disabled' };
  const stored = await chrome.storage.local.get(TIDY_LAST_RUN_STORAGE_KEY);
  const lastRun = stored[TIDY_LAST_RUN_STORAGE_KEY];
  if (lastRun?.at && Date.now() - lastRun.at < TIDY_RUN_INTERVAL_MS) {
    return { ok: true, skipped: 'cooldown' };
  }
  const response = await relayToKimiWebTab('tidy.auto.run', {}).catch((error) =>
    failure(error, 'TIDY_RELAY_FAILED')
  );
  if (!response?.ok) return response;
  const archived = Number(response.archived) || 0;
  await chrome.storage.local.set({
    [TIDY_LAST_RUN_STORAGE_KEY]: { at: Date.now(), archived, scanned: Number(response.scanned) || 0 }
  });
  // 与额度预警同款：后台通知不做双语（内容脚本侧文案才走 i18n）
  if (archived > 0) {
    chrome.notifications
      .create(`kimi-tidy-${Date.now()}`, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'Kimi 自动整理',
        message: `已按规则把 ${archived} 个不活跃对话移入「已完成」`,
        priority: 1
      })
      .catch(() => {});
  }
  return response;
}
