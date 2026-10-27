/**
 * 缓存提醒（桌面面板专属）
 *
 * 计时起点是「最后一次模型请求」，不是会话打开时间，也不是轮末：
 * 连续对话时每一轮都会续缓存，只有停下来才计时。数据来自 bridge.js 的
 * turn.started / turn.step.started（main agent），切会话时用快照 updated_at 落种。
 *
 * 四个槽位全部复用宠物模块现有 DOM，不发气泡：
 *   29–30 分钟：左上「对话缓存」/ 大字「即将过期」/ 左下「预估剩余」/ 右下倒计时
 * warn 段宠物持续黄色/琥珀（与警示文案同色），30 分钟恢复常规外观；
 * 新输入由 bridge 调 touch() 立即恢复常规状态。
 */

import { panel } from './panel-state.js';
import { renderPetStats } from './render.js';
import { petClockTick, petUpdateStatus } from './pet-panel.js';
import {
  CACHE_WARN_END_MS,
  cacheStageFor,
  formatCacheRemaining,
  parseIdleMinutes,
  shouldWarnSidebarIdle
} from '../cache-hint-rules.js';
import { t } from '../i18n.js';

let timer = null;

function enabled() {
  // 默认关闭：只有用户显式打开才生效（旧配置没有这个键也按关闭处理）
  return panel.widgetConfig?.modules?.pet?.cacheHint === true;
}

function visible() {
  return panel.widgetConfig?.modules?.pet?.show !== 'hidden'
    && Boolean(panel.els?.petLabel && panel.els?.petTotalText && panel.els?.petCanvas);
}

function idleNow() {
  return panel.metrics?.agentStatus === 'idle' && !panel.quotaAuthRequired;
}

function shortState() {
  return panel.widgetConfig?.modules?.pet?.span !== 2;
}

function removeClasses() {
  panel.els?.petCanvas?.classList.remove('ksb-cache-hot');
  panel.els?.petTotal?.classList.remove('ksb-cache-state', 'ksb-cache-warn');
  panel.els?.petStatus?.classList.remove('ksb-cache-warn');
}

// 把四槽还给常规渲染：先落 painted=false，render/pet-panel 的守卫才会放行
function restore() {
  if (!panel.cacheHint.painted) return;
  panel.cacheHint.painted = false;
  panel.els?.petRefresh?.classList.remove('ksb-cache-hide-refresh');
  removeClasses();
  if (panel.els?.petAmpm) panel.els.petAmpm.hidden = false;
  renderPetStats();
  petUpdateStatus(panel.metrics?.agentStatus || 'idle');
  petClockTick();
}

function paint(now) {
  const els = panel.els;
  if (!els?.petLabel || !els?.petTotalText || !els?.petStatusText || !els?.petClock || !els?.petClockNum) {
    return;
  }
  const elapsed = Math.max(0, now - panel.cacheHint.lastTouchAt);
  els.petLabel.textContent = t('对话缓存');
  els.petTotalText.textContent = t(shortState() ? '将过期' : '即将过期');
  els.petStatusText.textContent = t('预估剩余');
  els.petClockNum.textContent = formatCacheRemaining(CACHE_WARN_END_MS - elapsed);
  els.petClock.hidden = false;
  // 余额刷新图标只隐身、不 display:none：后者会让标签行变窄，字段名横向跳
  if (els.petRefresh && !els.petRefresh.hidden) {
    els.petRefresh.classList.add('ksb-cache-hide-refresh');
  }
  if (els.petAmpm) {
    els.petAmpm.textContent = '';
    els.petAmpm.hidden = true;
  }
  els.petCanvas?.classList.add('ksb-cache-hot');
  els.petTotal?.classList.add('ksb-cache-state', 'ksb-cache-warn');
  els.petStatus?.classList.add('ksb-cache-warn');
  panel.cacheHint.painted = true;
}

// 侧栏会话列表的相对时间：25–29 分钟标黄，给一个不用盯着面板的提示
function paintSidebarIdleTimes() {
  for (const el of document.querySelectorAll('.ksb-cache-idle-warn')) {
    el.classList.remove('ksb-cache-idle-warn');
  }
  if (!enabled()) return;
  for (const row of document.querySelectorAll('[data-session-id]')) {
    for (const el of row.querySelectorAll('span, time, div, small')) {
      if (el.children.length || el.closest('.t')) continue;
      const text = (el.textContent || '').trim();
      if (!text || text.length > 16) continue;
      const minutes = parseIdleMinutes(text);
      if (shouldWarnSidebarIdle(minutes)) {
        el.classList.add('ksb-cache-idle-warn');
      }
    }
  }
}

function sync() {
  paintSidebarIdleTimes();
  if (!enabled() || !visible()) {
    panel.cacheHint.stage = 'idle';
    restore();
    return;
  }
  const now = Date.now();
  const elapsed = panel.cacheHint.lastTouchAt > 0 ? now - panel.cacheHint.lastTouchAt : -1;
  const stage = cacheStageFor(elapsed);
  // 离线/未授权/正在回答时让位给真实状态
  const canPaint = stage !== 'idle' && idleNow();
  if (!canPaint) {
    // 不把未绘制的阶段留在 stage 里：恢复空闲后要按「首次进入」重播一次动画
    panel.cacheHint.stage = 'idle';
    restore();
    return;
  }
  panel.cacheHint.stage = stage;
  paint(now);
}

/* ---------- 外部接口 ---------- */

// 新请求/新一轮：缓存即将续上，立即回到常规状态
export function cacheHintTouch(at) {
  panel.cacheHint.lastTouchAt = Number.isFinite(at) && at > 0 ? at : Date.now();
  panel.cacheHint.stage = 'idle';
  restore();
}

// 切会话：用快照 updated_at 落种；传 0 表示无可用时间，按 idle
export function cacheHintSeed(at) {
  panel.cacheHint.lastTouchAt = Number.isFinite(at) && at > 0 ? at : 0;
  panel.cacheHint.stage = 'idle';
  restore();
  sync();
}

export function cacheHintReset() {
  cacheHintTouch(Date.now());
}

export function initCacheHint() {
  panel.cacheHint.lastTouchAt = 0;
  panel.cacheHint.stage = 'idle';
  panel.cacheHint.painted = false;
  if (!timer) timer = setInterval(() => sync(), 1_000);
  globalThis.__kcmCacheHint = {
    touch: cacheHintTouch,
    seed: cacheHintSeed,
    reset: cacheHintReset
  };
}

export function disposeCacheHint() {
  if (timer) clearInterval(timer);
  timer = null;
  restore();
  for (const el of document.querySelectorAll('.ksb-cache-idle-warn')) {
    el.classList.remove('ksb-cache-idle-warn');
  }
  try {
    delete globalThis.__kcmCacheHint;
  } catch (error) {
    globalThis.__kcmCacheHint = undefined;
  }
}
