/**
 * 宠物域
 *
 * 职责边界：
 * - Rive 吉祥物（面板内）：状态联动、命名动画播放、状态时钟、点击小动作。
 * - Codex 桌面宠物（页面上漫游）：素材加载、开关、拖拽位置/环视/大小持久化。
 * - 状态来源：渲染层经 initRender 钩子推状态（petUpdateStatus/roamPetSetStatus）；
 *   WS 域直接 import petBeginTurn/petCompleteTurn；面板状态读 panel-state.js。
 */

import { panel } from './panel-state.js';
import { STATUS_TEXT, PET_ANSWER_STATUSES, CONSOLE_URL, SUBSCRIPTION_URL } from './utils.js';
import { getDisplayedAgentStatus } from './render.js';
import { create as createRoamPet } from '../pet/sprites.js';

// 资产取自 kimi.com 前端公开 CDN（对话头像），运行时 @rive-app/canvas-lite 本地打包。
// 沿用 2.0.0 的命名动画方式：动作直接播放，颜色独立由 CSS 表达。
const PET_RIV_URL = chrome.runtime.getURL('rive/kimi_avatar_web-PnsTWI-X.riv');
const PET_WASM_URL = chrome.runtime.getURL('rive/rive.wasm');
const PET_IDLE_ANIM = 'paopao';
const PET_LOADING_ANIM = 'loading';
const PET_DONE_ANIM = 'stars';
// stars 只负责让星星出现，粒子退场由 nostars 负责（v2.0 的 stars→nostars 链）
const PET_DONE_OUTRO_ANIM = 'nostars';
const PET_CLICK_ANIMS = [
  'yaoyiyao', 'angryface', 'wink', 'angryeye',
  'hover', 'hover100', 'wink_stop', 'paopao_stop'
];
const PET_TOGGLE_ANIMS = [
  'yaoyiyao', 'angryface', 'wink', 'angryeye', 'hover', 'hover100'
];
// 不重新引入颜色/状态混合的官网状态机，只恢复它的低频空闲变化。
const PET_IDLE_AMBIENT_ANIMS = ['wink', 'look_right_stop'];
const PET_IDLE_AMBIENT_MIN_MS = 8_000;
const PET_IDLE_AMBIENT_JITTER_MS = 10_000;

let petRive = null;
let petCanvasEl = null;
// 记录点球监听器绑在哪个 canvas 上，结构重建时避免重复绑定
let petClickBoundCanvas = null;
let petStatus = 'idle';
let petMotion = '';
let petStarsVisible = false;
let petSwitchingMotion = false;
let petReturnToBase = false;
let petIdleAmbientTimer = null;
let petTurnSessionId = '';
let petTurnSince = 0;
// 状态时钟：进入当前状态的时间点与 1s 计时器
let petStatusSince = Date.now();
let petClockTimer = null;

const PET_CLOCK_STATUSES = ['thinking', 'executing', 'replying', 'subagent', 'ratelimit'];

/* ---------- 桌面宠物（Codex Pet）状态 ----------
 * 播放器在 pet/sprites.js，官方九行动画表 + 拖拽 + 状态联动。
 * 素材库在 IndexedDB（pet/store.js，popup 写入），content script 读不到扩展
 * IDB，经 background「pet.asset.active」消息取当前宠物的 data URL；切换实时生效。
 * 拖拽停放位置持久化在 storage。开关存独立 key，不并入 widget 布局配置。 */
const ROAM_PET_STORAGE_KEY = 'kimi-statusbar.roamPet';
const PET_ACTIVE_ID_STORAGE_KEY = 'kimi-statusbar.petActiveId';
const PET_POS_STORAGE_KEY = 'kimi-statusbar.petPos';
const PET_LOOK_STORAGE_KEY = 'kimi-statusbar.petLook'; // 环视开关（仅 v2 图集生效）
const PET_SCALE_STORAGE_KEY = 'kimi-statusbar.petScale'; // 宠物大小（百分比 50–150）
const PET_LOOK_RADIUS = 400;
let roamPet = null;
let roamPetStarting = false;
let roamPetEnabledFlag = false;
let roamPetAssetUrl = '';
let roamPetPos = null;
let roamPetLookFlag = true;
let roamPetScale = 1;

// 装配时注入的生命周期依赖（content.js）
let deps = {
  isDisposed: () => false,
  getSessionId: () => ''
};

export function initPet(nextDeps) {
  deps = { ...deps, ...nextDeps };
}

/* ---------- 状态时钟 ---------- */

function petClockStart() {
  if (petClockTimer) return;
  petClockTimer = setInterval(petClockTick, 1_000);
  petClockTick();
}

export function petClockTick() {
  if (!panel.els?.petClock || !panel.els.petClockNum) return;
  const pad = (n) => String(n).padStart(2, '0');
  if (!PET_CLOCK_STATUSES.includes(petStatus)) {
    // 日常：挂钟（12 小时制 h:MM，AM/PM 独立标签便于窄宽降级）
    const now = new Date();
    const hours = now.getHours();
    const h12 = hours % 12 === 0 ? 12 : hours % 12;
    panel.els.petClock.hidden = false;
    panel.els.petClockNum.textContent = `${h12}:${pad(now.getMinutes())}`;
    if (panel.els.petAmpm) panel.els.petAmpm.textContent = hours < 12 ? 'AM' : 'PM';
    return;
  }
  // 活跃状态：本轮回答（或该状态）的已用时长
  const seconds = Math.floor((Date.now() - petStatusSince) / 1_000);
  const s = seconds % 60;
  const m = Math.floor(seconds / 60) % 60;
  const h = Math.floor(seconds / 3600);
  panel.els.petClock.hidden = false;
  panel.els.petClockNum.textContent = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  if (panel.els.petAmpm) panel.els.petAmpm.textContent = '';
}

// 计时起点的读/写：同页切会话时由会话缓存域保存与恢复（计时连续）
export function getPetStatusSince() {
  return petStatusSince;
}

export function setPetStatusSince(timestamp) {
  petStatusSince = timestamp;
}

/* ---------- Rive 吉祥物 ---------- */

function petAppearanceForStatus(status) {
  if (status === 'offline' || status === 'unauthorized') return 'gray';
  if (status === 'ratelimit') return 'red';
  return 'blue';
}

function petApplyAppearance() {
  if (!panel.els?.petCanvas) return;
  panel.els.petCanvas.dataset.appearance = petAppearanceForStatus(petStatus);
}

function petClearIdleAmbient() {
  if (petIdleAmbientTimer) clearTimeout(petIdleAmbientTimer);
  petIdleAmbientTimer = null;
}

function petScheduleIdleAmbient() {
  petClearIdleAmbient();
  if (petStatus !== 'idle' || !petRive) return;
  const delay = PET_IDLE_AMBIENT_MIN_MS + Math.random() * PET_IDLE_AMBIENT_JITTER_MS;
  petIdleAmbientTimer = setTimeout(() => {
    petIdleAmbientTimer = null;
    if (deps.isDisposed()) return;
    if (petStatus !== 'idle' || petMotion !== PET_IDLE_ANIM || !petRive) {
      petScheduleIdleAmbient();
      return;
    }
    const name = PET_IDLE_AMBIENT_ANIMS[
      Math.floor(Math.random() * PET_IDLE_AMBIENT_ANIMS.length)
    ];
    petPlayMotion(name, { returnToBase: true });
  }, delay);
}

function petPlayMotion(name, { returnToBase = false } = {}) {
  if (!petRive) return;
  petClearIdleAmbient();
  try {
    petSwitchingMotion = true;
    petReturnToBase = returnToBase;
    petRive.stop();
    petRive.play(name);
    petMotion = name;
    if (name === PET_IDLE_ANIM) petScheduleIdleAmbient();
  } catch (error) {
    console.warn('[Kimi Status] 吉祥物动画切换失败', error);
  } finally {
    petSwitchingMotion = false;
  }
}

function petBaseMotion() {
  return PET_ANSWER_STATUSES.includes(petStatus) ? PET_LOADING_ANIM : PET_IDLE_ANIM;
}

function petPlayBase() {
  // 星星粒子还挂着：先播 nostars 让它们退场，再回到基底。
  // 覆盖 stars 自然结束与 stars 被打断两条路径（被打断时粒子停留中途帧）
  if (petStarsVisible && petMotion !== PET_DONE_OUTRO_ANIM) {
    petPlayMotion(PET_DONE_OUTRO_ANIM, { returnToBase: true });
    return;
  }
  const desired = petBaseMotion();
  if (petMotion === desired && petRive?.playingAnimationNames?.includes(desired)) return;
  petPlayMotion(desired);
}

function petSyncState() {
  petApplyAppearance();
  petPlayBase();
}

export function petBeginTurn() {
  petTurnSessionId = deps.getSessionId();
  panel.petTurnActive = Boolean(deps.getSessionId());
  petTurnSince = Date.now();
}

export function petCancelTurn() {
  petTurnSessionId = '';
  panel.petTurnActive = false;
  petTurnSince = 0;
}

export function petCompleteTurn() {
  // 重放的历史事件里 turn.started 与 turn.ended 间隔只有几毫秒；
  // 真实一轮回答至少持续一秒以上，据此抑制重放触发的 Stars
  const shouldCelebrate =
    panel.petTurnActive &&
    petTurnSessionId === deps.getSessionId() &&
    Date.now() - petTurnSince > 1_000;
  petCancelTurn();
  if (shouldCelebrate) petPlayDoneEffect();
}

function petHandleClick() {
  const name = PET_CLICK_ANIMS[Math.floor(Math.random() * PET_CLICK_ANIMS.length)];
  petPlayMotion(name, { returnToBase: true });
}

export function petHandleToggle() {
  const name = PET_TOGGLE_ANIMS[Math.floor(Math.random() * PET_TOGGLE_ANIMS.length)];
  petPlayMotion(name, { returnToBase: true });
}

// Stars 只由真实 turn 生命周期触发，播放完回到当前基底动画。
function petPlayDoneEffect() {
  if (!petRive || petMotion === PET_DONE_ANIM) return;
  petStarsVisible = true;
  petPlayMotion(PET_DONE_ANIM, { returnToBase: true });
}

// Mini 折叠时宠物画布高度归 0，Rive 对 0 尺寸画布持续渲染可能卡死页面：
// 宠物不在迷你区且处于 Mini 时暂停渲染，展开恢复
export function petSyncRendering() {
  if (!petRive) return;
  const petInMini = panel.widgetConfig.orderMini.includes('pet');
  const collapsed = Boolean(panel.els?.widget?.classList.contains('ksb-mini')) && !petInMini;
  try {
    if (collapsed) petRive.stopRendering();
    else petRive.startRendering();
  } catch (error) {
    // 忽略
  }
}

// 结构重建后调用：canvas 未变且实例存活时复用（避免配置回声造成 Rive 双重实例化）
export function petStart() {
  const api = globalThis.rive;
  if (!api?.Rive || !api?.RuntimeLoader) return;
  if (petRive && panel.els?.petCanvas && panel.els.petCanvas === petCanvasEl) return;
  if (petRive) {
    try {
      petRive.cleanup();
    } catch (error) {
      // 忽略
    }
    petRive = null;
    petCanvasEl = null;
    petMotion = '';
    petStarsVisible = false;
    petSwitchingMotion = false;
    petReturnToBase = false;
    petClearIdleAmbient();
  }
  if (!panel.els?.petCanvas) return;
  // wasm 强制走本地，禁用 CDN 回退（扩展不允许远程代码）
  api.RuntimeLoader.setWasmUrl(PET_WASM_URL);
  api.RuntimeLoader.setWasmFallbackUrl(null);
  const instance = new api.Rive({
    src: PET_RIV_URL,
    canvas: panel.els.petCanvas,
    autoplay: false,
    fit: api.Fit?.Contain,
    alignment: api.Alignment?.Center,
    onLoad: () => {
      if (petRive !== instance) return;
      petSyncState();
    },
    onStop: (event) => {
      // stop()+play() 的主动切换不处理；只有 one-shot 自然结束才续播。
      if (petRive !== instance || petSwitchingMotion) return;
      const stopped = Array.isArray(event?.data) ? event.data : [];
      if (!stopped.includes(petMotion)) return;
      queueMicrotask(() => {
        if (petRive !== instance || petSwitchingMotion) return;
        if (petMotion === PET_LOADING_ANIM && PET_ANSWER_STATUSES.includes(petStatus)) {
          petPlayMotion(PET_LOADING_ANIM);
          return;
        }
        // nostars 自然播完才认定粒子已退场（中途被打断则保留标记，下次回基底时补播）
        if (petMotion === PET_DONE_OUTRO_ANIM) petStarsVisible = false;
        if (petReturnToBase) {
          petReturnToBase = false;
          petPlayBase();
        }
      });
    },
    onLoadError: (error) => console.warn('[Kimi Status] 吉祥物动画加载失败', error)
  });
  petRive = instance;
  petCanvasEl = panel.els.petCanvas;
  petApplyAppearance();
  petSyncRendering();
  petClockStart();
  // 点球：播放一次命名动作；配置了跳转则同时打开（控制台/充值页，≡ 菜单可选）。
  // 同一 canvas 只绑一次，避免结构复用时重复触发。
  if (petClickBoundCanvas !== panel.els.petCanvas) {
    panel.els.petCanvas.addEventListener('click', (event) => {
      event.stopPropagation();
      petHandleClick();
      const link = panel.widgetConfig.modules.pet?.ballLink;
      if (link === 'console' || link === 'subscription') {
        window.open(link === 'console' ? CONSOLE_URL : SUBSCRIPTION_URL, '_blank');
      }
    });
    petClickBoundCanvas = panel.els.petCanvas;
  }
}

// 与状态灯同源：命名动画只负责动作，CSS 只负责蓝/灰/红外观。
// Stars 由同一会话的 turn 生命周期触发，不再从显示状态变化推断。
export function petUpdateStatus(display) {
  if (panel.els?.petStatusText) {
    panel.els.petStatusText.textContent = STATUS_TEXT[display] || display;
    panel.els.petStatus.dataset.status = display;
  }
  if (display === petStatus) {
    // 重复状态只刷新颜色，不能打断正在播放的 Stars / 点击动作；
    // loading 自然结束后的续播由唯一的 onStop 分支负责。
    petApplyAppearance();
    return;
  }
  const previous = petStatus;
  petStatus = display;
  // 计时不被工具调用打断：仅在「非回答状态 → 回答状态」或进入非回答状态时重置起点；
  // 思考↔回复↔调用↔子代理↔限流之间切换属于同一轮回答，连续计时
  if (PET_ANSWER_STATUSES.includes(display) && !PET_ANSWER_STATUSES.includes(previous)) {
    petStatusSince = Date.now();
  } else if (!PET_ANSWER_STATUSES.includes(display)) {
    petStatusSince = Date.now();
  }
  petClockTick();
  petSyncState();
}

// 页面销毁时清理宠物域持有的定时器与实例（content.js dispose 调用）
export function disposePet() {
  if (petClockTimer) clearInterval(petClockTimer);
  petClockTimer = null;
  petClearIdleAmbient();
  if (petRive) {
    try {
      petRive.cleanup();
    } catch (error) {
      // 忽略
    }
    petRive = null;
    petCanvasEl = null;
    petMotion = '';
    petStarsVisible = false;
    petSwitchingMotion = false;
    petReturnToBase = false;
  }
  petCancelTurn();
  roamPetStop();
}

/* ---------- 桌面宠物（Codex Pet） ---------- */

export function roamPetSetStatus(display) {
  try {
    roamPet?.setStatus(display);
  } catch (error) {
    // 宠物动作切换失败不影响面板
  }
}

export async function roamPetStart() {
  if (roamPet || roamPetStarting || deps.isDisposed()) return;
  if (!roamPetEnabledFlag || !roamPetAssetUrl || !document.body) return;
  roamPetStarting = true;
  const assetUrl = roamPetAssetUrl;
  const startPos = roamPetPos;
  try {
    const instance = await createRoamPet({
      imageUrl: assetUrl,
      position: startPos,
      zIndex: 9998,
      scale: roamPetScale,
      look: { enabled: roamPetLookFlag, radius: PET_LOOK_RADIUS },
      onPositionChange: (pos) => {
        roamPetPos = pos;
        chrome.storage.local.set({ [PET_POS_STORAGE_KEY]: pos }).catch(() => {});
      }
    });
    // 等待素材期间页面已销毁、开关被关掉或素材已更换：立即回收，避免僵尸宠物
    if (deps.isDisposed() || !roamPetEnabledFlag || assetUrl !== roamPetAssetUrl) {
      instance.destroy();
      return;
    }
    roamPet = instance;
    roamPetSetStatus(getDisplayedAgentStatus() || 'idle');
  } catch (error) {
    console.warn('[Kimi Status] 桌面宠物加载失败', error);
  } finally {
    roamPetStarting = false;
  }
}

export function roamPetStop() {
  if (!roamPet) return;
  try {
    roamPet.destroy();
  } catch (error) {
    // 忽略
  }
  roamPet = null;
}

function roamPetApplyEnabled(enabled) {
  roamPetEnabledFlag = enabled;
  if (enabled) roamPetStart();
  else roamPetStop();
}

// 存储值（百分比 50–150）→ 缩放倍率（0.5–1.5），非法值回 1
function roamPetClampScale(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(150, Math.max(50, Math.round(n))) / 100 : 1;
}

export async function roamPetLoadConfig() {
  if (deps.isDisposed()) return;
  try {
    const stored = await chrome.storage.local.get([
      ROAM_PET_STORAGE_KEY, PET_POS_STORAGE_KEY, PET_LOOK_STORAGE_KEY, PET_SCALE_STORAGE_KEY
    ]);
    // 默认关闭：popup 卡片收起，页面上不出现宠物
    roamPetEnabledFlag = stored[ROAM_PET_STORAGE_KEY] === true;
    roamPetPos = stored[PET_POS_STORAGE_KEY] && Number.isFinite(stored[PET_POS_STORAGE_KEY].x)
      ? stored[PET_POS_STORAGE_KEY]
      : null;
    roamPetLookFlag = stored[PET_LOOK_STORAGE_KEY] !== false;
    roamPetScale = roamPetClampScale(stored[PET_SCALE_STORAGE_KEY]);
    roamPetAssetUrl = await roamPetFetchAsset();
  } catch (error) {
    console.warn('[Kimi Status] 读取桌面宠物配置失败', error);
    roamPetEnabledFlag = false;
  }
  if (deps.isDisposed()) return;
  roamPetApplyEnabled(roamPetEnabledFlag);
}

// 经 background 从素材库取当前宠物的 data URL（未安装/未选择时为空串）
async function roamPetFetchAsset() {
  if (deps.isDisposed()) return '';
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'pet.asset.active' });
    return resp?.ok && typeof resp.dataUrl === 'string' ? resp.dataUrl : '';
  } catch (error) {
    return '';
  }
}

// 桌面宠物相关的 storage 变更（popup 写入实时生效）；由 content.js 的 storage 总线调用
export function handlePetStorageChanged(changes) {
  // 桌面宠物开关（popup 写入）：缺省/删除都视为关闭
  if (changes[ROAM_PET_STORAGE_KEY]) {
    roamPetApplyEnabled(changes[ROAM_PET_STORAGE_KEY].newValue === true);
  }
  // 切换当前宠物（popup 素材库点「切换」/新装/删除后落到下一只）：重新取图重建
  if (changes[PET_ACTIVE_ID_STORAGE_KEY]) {
    roamPetFetchAsset().then((assetUrl) => {
      if (deps.isDisposed()) return;
      roamPetAssetUrl = assetUrl;
      roamPetStop();
      roamPetStart();
    });
  }
  // 环视开关：重建宠物生效（位置已持久化，无感）
  if (changes[PET_LOOK_STORAGE_KEY]) {
    roamPetLookFlag = changes[PET_LOOK_STORAGE_KEY].newValue !== false;
    if (!deps.isDisposed()) { roamPetStop(); roamPetStart(); }
  }
  // 宠物大小：重建宠物生效
  if (changes[PET_SCALE_STORAGE_KEY]) {
    roamPetScale = roamPetClampScale(changes[PET_SCALE_STORAGE_KEY].newValue);
    if (!deps.isDisposed()) { roamPetStop(); roamPetStart(); }
  }
}
