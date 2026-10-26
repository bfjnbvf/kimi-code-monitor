/**
 * 缓存过期提醒（桌面面板专属）
 *
 * 计时起点是「最后一次模型请求」，不是会话打开时间，也不是轮末：
 * 连续对话时每一轮都会续缓存，只有停下来才计时。数据来自 bridge.js 的
 * turn.started / turn.step.started（main agent），切会话时用快照 updated_at 落种。
 *
 * 四个槽位全部复用宠物模块现有 DOM，不发气泡：
 *   27 分钟：左上「对话缓存」/ 大字「即将过期」/ 左下「预估剩余」/ 右下倒计时
 *   30 分钟：左上「对话缓存」/ 大字「可能过期」/ 左下「已闲置」/ 右下已闲置分钟数
 * warn 段宠物持续黄色/琥珀（与警示文案同色），cold 段转灰；
 * 新输入由 bridge 调 touch() 立即恢复常规状态。
 */

import { panel } from './panel-state.js';
import { renderPetStats } from './render.js';
import { petClockTick, petUpdateStatus } from './pet-panel.js';
import {
  CACHE_COLD_MS,
  CACHE_WARN_MS,
  cacheStageFor,
  formatCacheIdleMinutes,
  formatCacheRemaining,
  parseIdleMinutes
} from '../cache-hint-rules.js';
import { t } from '../i18n.js';

let timer = null;
let previewTimer = null;
let previewPrevTouch = null;

function enabled() {
  return panel.widgetConfig?.modules?.pet?.cacheHint !== false;
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
  panel.els?.petCanvas?.classList.remove('ksb-cache-hot', 'ksb-cache-cold');
  panel.els?.petTotal?.classList.remove('ksb-cache-state', 'ksb-cache-warn', 'ksb-cache-cold');
  panel.els?.petStatus?.classList.remove('ksb-cache-warn', 'ksb-cache-cold');
}

// 把四槽还给常规渲染：先落 painted=false，render/pet-panel 的守卫才会放行
function restore() {
  if (!panel.cacheHint.painted) return;
  panel.cacheHint.painted = false;
  removeClasses();
  if (panel.els?.petAmpm) panel.els.petAmpm.hidden = false;
  renderPetStats();
  petUpdateStatus(panel.metrics?.agentStatus || 'idle');
  petClockTick();
}

function paint(stage, now) {
  const els = panel.els;
  if (!els?.petLabel || !els?.petTotalText || !els?.petStatusText || !els?.petClock || !els?.petClockNum) {
    return;
  }
  const elapsed = Math.max(0, now - panel.cacheHint.lastTouchAt);
  els.petLabel.textContent = t('对话缓存');
  if (stage === 'warn') {
    els.petTotalText.textContent = t(shortState() ? '将过期' : '即将过期');
    els.petStatusText.textContent = t('预估剩余');
    els.petClockNum.textContent = formatCacheRemaining(CACHE_COLD_MS - elapsed);
  } else {
    els.petTotalText.textContent = t(shortState() ? '已过期' : '可能过期');
    els.petStatusText.textContent = t('已闲置');
    els.petClockNum.textContent = t('{n} 分钟', { n: formatCacheIdleMinutes(elapsed) });
  }
  els.petClock.hidden = false;
  // 余额口径才有的刷新图标在提醒态没有意义，先收起；restore 时 renderPetStats 会还原
  if (els.petRefresh) els.petRefresh.hidden = true;
  if (els.petAmpm) {
    els.petAmpm.textContent = '';
    els.petAmpm.hidden = true;
  }
  els.petCanvas?.classList.toggle('ksb-cache-hot', stage === 'warn');
  els.petCanvas?.classList.toggle('ksb-cache-cold', stage === 'cold');
  els.petTotal?.classList.add('ksb-cache-state');
  els.petTotal?.classList.toggle('ksb-cache-warn', stage === 'warn');
  els.petTotal?.classList.toggle('ksb-cache-cold', stage === 'cold');
  els.petStatus?.classList.toggle('ksb-cache-warn', stage === 'warn');
  els.petStatus?.classList.toggle('ksb-cache-cold', stage === 'cold');
  panel.cacheHint.painted = true;
}

// 侧栏会话列表的相对时间：27–29 分钟标黄，给一个不用盯着面板的提示
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
      if (minutes != null && minutes >= 27 && minutes < 30) {
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
  // 离线/未授权/正在回答时让位给真实状态；预览模式例外，方便看样式
  const canPaint = stage !== 'idle' && (idleNow() || panel.cacheHint.preview === true);
  if (!canPaint) {
    // 不把未绘制的阶段留在 stage 里：恢复空闲后要按「首次进入」重播一次动画
    panel.cacheHint.stage = 'idle';
    restore();
    return;
  }
  panel.cacheHint.stage = stage;
  paint(stage, now);
}

/* ---------- 外部接口 ---------- */

// 新请求/新一轮：缓存即将续上，立即回到常规状态
export function cacheHintTouch(at) {
  clearPreview();
  panel.cacheHint.lastTouchAt = Number.isFinite(at) && at > 0 ? at : Date.now();
  panel.cacheHint.stage = 'idle';
  panel.cacheHint.preview = false;
  restore();
}

// 切会话：用快照 updated_at 落种；传 0 表示无可用时间，按 idle
export function cacheHintSeed(at) {
  clearPreview();
  panel.cacheHint.lastTouchAt = Number.isFinite(at) && at > 0 ? at : 0;
  panel.cacheHint.stage = 'idle';
  panel.cacheHint.preview = false;
  restore();
  sync();
}

export function cacheHintReset() {
  cacheHintTouch(Date.now());
}

// 预览：临时改 lastTouchAt，8 秒后恢复真实计时；供 ≡ 菜单试用
export function cacheHintPreview(stage) {
  if (previewPrevTouch == null) previewPrevTouch = panel.cacheHint.lastTouchAt;
  clearPreviewTimer();
  if (stage === 'idle') {
    panel.cacheHint.lastTouchAt = previewPrevTouch || 0;
    previewPrevTouch = null;
    panel.cacheHint.preview = false;
    panel.cacheHint.stage = 'idle';
    restore();
    sync();
    return;
  }
  panel.cacheHint.preview = true;
  panel.cacheHint.stage = 'idle';
  panel.cacheHint.lastTouchAt = Date.now()
    - (stage === 'warn' ? CACHE_WARN_MS : CACHE_COLD_MS + 60_000);
  sync();
  previewTimer = setTimeout(() => {
    previewTimer = null;
    panel.cacheHint.lastTouchAt = previewPrevTouch || 0;
    previewPrevTouch = null;
    panel.cacheHint.preview = false;
    panel.cacheHint.stage = 'idle';
    restore();
    sync();
  }, 12_000);
}

function clearPreviewTimer() {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = null;
}

function clearPreview() {
  clearPreviewTimer();
  previewPrevTouch = null;
  panel.cacheHint.preview = false;
}

export function initCacheHint() {
  panel.cacheHint.lastTouchAt = 0;
  panel.cacheHint.stage = 'idle';
  panel.cacheHint.painted = false;
  panel.cacheHint.preview = false;
  if (!timer) timer = setInterval(() => sync(), 1_000);
  globalThis.__kcmCacheHint = {
    touch: cacheHintTouch,
    seed: cacheHintSeed,
    reset: cacheHintReset,
    preview: cacheHintPreview
  };
}

export function disposeCacheHint() {
  if (timer) clearInterval(timer);
  timer = null;
  clearPreview();
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
