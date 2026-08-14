/* Codex Pet 播放器：一个 div + CSS background-position 逐帧播放，无 canvas。
 *
 * 图集契约（与 Codex 官方完全一致，社区宠物零转换直接用）：
 * - spritesheet.webp，8 列，每格 192x208，每一行一个动作；
 * - v1 共 9 行（1536x1872），v2 共 11 行（前 9 行相同，多出的环视行不消费）。
 *
 * 播放语义照抄 Codex 官方（codex-rs pets/model.rs + 桌面版默认事件）：
 * - idle 帧时长是预览表的 6 倍（官方低干扰降速：[1680,660,660,840,840,1920]ms），
 *   其余行与官方一致；
 * - 应用状态：干活=running、等输入=waiting、完成=review、失败=failed；
 *   官方把所有活跃工作（思考/跑命令/编辑…）合并为 running 一个状态；
 * - 一次性动作播完直接回基底循环（官方 fallback 语义，不做额外收尾）；
 * - 交互：hover → jumping；拖拽左/右 → running-left/right，上 → waving，下 → jumping；
 * - 环视（仅 v2 图集，rows 9-10 的 16 方向）：指针进入设定半径内时转头注视，
 *   带滞后区间防抖；仅 idle 状态生效，拖拽/忙碌/定格时不转头；
 * - prefers-reduced-motion：静态显示 idle 第一帧（官方约定）。
 *
 * 经典脚本，content script 直接加载，全局暴露 CodexRoamPet。
 */
'use strict';

const CELL_W = 192;
const CELL_H = 208;
const COLS = 8;

// 官方动画表：行号 + 每帧时长 ms
const STATES = {
  idle: { row: 0, durations: [1680, 660, 660, 840, 840, 1920] },
  'running-right': { row: 1, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  'running-left': { row: 2, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  waving: { row: 3, durations: [140, 140, 140, 280] },
  jumping: { row: 4, durations: [140, 140, 140, 140, 280] },
  failed: { row: 5, durations: [140, 140, 140, 140, 140, 140, 140, 240] },
  waiting: { row: 6, durations: [150, 150, 150, 150, 150, 260] },
  running: { row: 7, durations: [120, 120, 120, 120, 120, 220] },
  review: { row: 8, durations: [150, 150, 150, 150, 150, 280] }
};

// 宿主 agent 状态 → 图集动作（与官方「活跃工作合并为 running」一致）
const AGENT_STATE_MAP = {
  idle: 'idle',
  thinking: 'running',
  executing: 'running',
  replying: 'running',
  subagent: 'running',
  ratelimit: 'failed',
  offline: 'failed',
  unauthorized: 'failed'
};
const BUSY_STATUSES = ['thinking', 'executing', 'replying', 'subagent'];
const DEAD_STATUSES = ['offline', 'unauthorized'];

const HOVER_COOLDOWN_MS = 4000;
const HOVER_DWELL_MS = 300; // 悬停停留这么久才起跳：路过/靠近（环视）不触发
const DRAG_COMMIT_PX = 12; // 方向提交的累积位移阈值（磁滞防抖，斜拖不乱跳）
const DRAG_FREEZE_MS = 250;
const DRAG_FREEZE_POLL_MS = 120;
const DEFAULT_POS = { right: 24, bottom: 24 }; // 未拖拽过时停靠右下角

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('spritesheet load failed: ' + src));
    im.src = src;
  });
}

/**
 * 创建一只桌面宠物。
 * @param {object} opts
 * @param {string} opts.imageUrl 图集 URL（chrome.runtime.getURL 或 data: URL）
 * @param {{x:number,y:number}|null} [opts.position] 上次拖拽停放的位置（CSS px，相对视口左上）
 * @param {Function} [opts.onPositionChange] 拖拽停放后的位置回调（用于持久化）
 * @param {{enabled:boolean, radius:number}} [opts.look] 环视：enabled 且 v2 图集时，
 *        指针进入 radius 像素内开始注视（滞后 50px 退出），缺省不启用
 * @param {number} [opts.zIndex=9998]
 * @returns {Promise<{el: HTMLElement, setStatus: Function, destroy: Function}>}
 */
async function create(opts) {
  const imageUrl = opts && opts.imageUrl;
  if (!imageUrl) throw new Error('CodexRoamPet: imageUrl is required');
  const onPositionChange = typeof opts?.onPositionChange === 'function' ? opts.onPositionChange : null;
  const zIndex = Number.isFinite(opts?.zIndex) ? opts.zIndex : 9998;
  // 显示缩放：默认 1（原始像素 192x208），背景图与取帧坐标同步缩放
  const scale = Number.isFinite(opts?.scale) && opts.scale > 0 ? opts.scale : 1;
  const viewW = CELL_W * scale;
  const viewH = CELL_H * scale;

  // 校验图集合规（CSS 背景按自然尺寸渲染，无需读取宽高参与绘制）
  const img = await loadImage(imageUrl);
  const rows = Math.floor(img.height / CELL_H);
  if (img.width !== CELL_W * COLS || img.height % CELL_H !== 0 || rows < 9) {
    throw new Error(`CodexRoamPet: unexpected atlas size ${img.width}x${img.height}`);
  }

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const el = document.createElement('div');
  el.className = 'codex-roam-pet';
  el.style.cssText =
    `position:fixed;z-index:${zIndex};width:${viewW}px;height:${viewH}px;margin:0;padding:0;` +
    `background-image:url("${imageUrl.replace(/"/g, '%22')}");background-repeat:no-repeat;` +
    `background-size:${CELL_W * COLS * scale}px auto;` +
    'image-rendering:pixelated;image-rendering:crisp-edges;' +
    'cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none;';
  document.body.appendChild(el);

  /* ---------- 位置：拖到哪儿停在哪儿 ---------- */

  let posX = null; // null = 未拖拽过，停靠默认右下角
  let posY = null;

  function applyPosition() {
    if (posX === null) {
      el.style.right = `${DEFAULT_POS.right}px`;
      el.style.bottom = `${DEFAULT_POS.bottom}px`;
      el.style.left = 'auto';
      el.style.top = 'auto';
      return;
    }
    el.style.left = `${Math.round(posX)}px`;
    el.style.top = `${Math.round(posY)}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  }

  function clampPos(x, y) {
    return [
      Math.min(Math.max(x, 0), Math.max(0, window.innerWidth - viewW)),
      Math.min(Math.max(y, 0), Math.max(0, window.innerHeight - viewH))
    ];
  }

  if (opts?.position && Number.isFinite(opts.position.x) && Number.isFinite(opts.position.y)) {
    [posX, posY] = clampPos(opts.position.x, opts.position.y);
  }
  applyPosition();

  /* ---------- 播放核心：定时器逐帧改 background-position ----------
   * current 正在播放的动作；base 是 agent 状态决定的基底循环；
   * pending 是一次性动作队列，播空后回到 base。 */

  let timer = null;
  let timerActive = false;
  let frame = 0;
  let current = 'idle';
  let loopCurrent = true;
  let base = 'idle';
  let pending = [];
  let frozen = false; // 离线/未授权：播完 failed 后定格灰显

  function showFrame() {
    const def = STATES[current];
    el.style.backgroundPosition = `${-frame * CELL_W * scale}px ${-def.row * CELL_H * scale}px`;
  }

  function scheduleNext() {
    if (timer) clearTimeout(timer);
    timerActive = false;
    if (reduced) return;
    if (frozen && current === base) return; // 定格在基底第一帧
    timerActive = true;
    timer = setTimeout(tick, STATES[current].durations[frame]);
  }

  function enter(name, { loop = false } = {}) {
    const def = STATES[name];
    if (!def) return;
    if (reduced && name !== 'idle') return;
    current = name;
    loopCurrent = loop;
    frame = 0;
    showFrame();
    scheduleNext();
  }

  function tick() {
    timerActive = false;
    // 拖拽中指针停顿：冻结在当前帧，轮询等待下一次移动
    if (dragging && performance.now() - dragLastMoveTs > DRAG_FREEZE_MS) {
      timerActive = true;
      timer = setTimeout(tick, DRAG_FREEZE_POLL_MS);
      return;
    }
    const def = STATES[current];
    frame += 1;
    if (frame >= def.durations.length) {
      if (loopCurrent) {
        frame = 0;
      } else if (pending.length > 0) {
        enter(pending.shift(), { loop: false });
        return;
      } else if (dragging) {
        frame = def.durations.length - 1; // 拖拽中的竖直方向动作：定格等松手
        showFrame();
        return;
      } else {
        enter(base, { loop: true }); // 一次性动作播完，回基底
        return;
      }
    }
    showFrame();
    scheduleNext();
  }

  // 播一条一次性动作链（自动接回基底）
  function playChain(names) {
    pending = names.slice(1);
    enter(names[0], { loop: false });
  }

  /* ---------- agent 状态联动 ---------- */

  let agentStatus = 'idle';

  function setStatus(status) {
    const next = typeof status === 'string' && AGENT_STATE_MAP[status] ? status : 'idle';
    if (next === agentStatus) return;
    const prevBusy = BUSY_STATUSES.includes(agentStatus);
    agentStatus = next;
    const dead = DEAD_STATUSES.includes(next);
    el.classList.toggle('codex-roam-pet-dim', dead);
    frozen = dead;
    const prevBase = base;
    base = dead ? 'idle' : AGENT_STATE_MAP[next];
    if (reduced || dragging) return; // 拖拽中不切换，松手后按最新状态恢复

    if (dead) {
      playChain(['failed']); // failed 播一遍 → 灰显定格（frozen 生效于回基底时）
      return;
    }
    if (prevBusy && next === 'idle') {
      playChain(['review']); // 一轮工作完成：review 播一遍回 idle
      return;
    }
    // 基底没变且正在播基底：不打断（避免 thinking↔executing 抖动）
    if (base === prevBase && current === base && timerActive) return;
    pending = [];
    enter(base, { loop: true });
  }

  /* ---------- 交互：hover 起跳 + 拖拽（官方方向映射） ---------- */

  let dragging = false;
  let hoverCooldownUntil = 0;
  let hoverDwellTimer = null;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let dragLastX = 0;
  let dragLastY = 0;
  let dragLastMoveTs = 0;
  let dragDir = '';
  let dragAccumX = 0;
  let dragAccumY = 0;

  function onPointerEnter() {
    if (reduced || dragging || frozen) return;
    if (Date.now() < hoverCooldownUntil) return;
    // 停留起跳：只是路过或靠近（环视）不触发
    if (hoverDwellTimer) clearTimeout(hoverDwellTimer);
    hoverDwellTimer = setTimeout(() => {
      hoverDwellTimer = null;
      if (dragging) return;
      hoverCooldownUntil = Date.now() + HOVER_COOLDOWN_MS;
      playChain(['jumping']); // 官方：hover → jumping，播完直接回基底
    }, HOVER_DWELL_MS);
  }

  function onPointerLeave() {
    if (hoverDwellTimer) {
      clearTimeout(hoverDwellTimer);
      hoverDwellTimer = null;
    }
  }

  function onPointerDown(event) {
    if (dragging) return;
    dragging = true;
    try { el.setPointerCapture(event.pointerId); } catch (e) { /* 忽略 */ }
    const rect = el.getBoundingClientRect();
    dragOffsetX = event.clientX - rect.left;
    dragOffsetY = event.clientY - rect.top;
    dragLastX = event.clientX;
    dragLastY = event.clientY;
    dragLastMoveTs = performance.now();
    dragDir = '';
    dragAccumX = 0;
    dragAccumY = 0;
    el.classList.add('codex-roam-pet-held');
    event.preventDefault();
  }

  // 官方桌面版拖拽方向映射：左/右 → running-left/right，上 → waving，下 → jumping
  function dragDirAnim(dir) {
    if (dir === dragDir || reduced) return;
    dragDir = dir;
    if (dir === 'left') enter('running-left', { loop: true });
    else if (dir === 'right') enter('running-right', { loop: true });
    else if (dir === 'up') enter('waving', { loop: false });
    else if (dir === 'down') enter('jumping', { loop: false });
  }

  function onPointerMove(event) {
    if (!dragging) return;
    dragAccumX += event.clientX - dragLastX;
    dragAccumY += event.clientY - dragLastY;
    dragLastX = event.clientX;
    dragLastY = event.clientY;
    dragLastMoveTs = performance.now();
    // 累积位移过阈值才提交一次方向，避免斜拖/抖动在动画间乱跳
    if (Math.abs(dragAccumX) >= DRAG_COMMIT_PX || Math.abs(dragAccumY) >= DRAG_COMMIT_PX) {
      const dir = Math.abs(dragAccumX) >= Math.abs(dragAccumY)
        ? (dragAccumX < 0 ? 'left' : 'right')
        : (dragAccumY < 0 ? 'up' : 'down');
      dragAccumX = 0;
      dragAccumY = 0;
      dragDirAnim(dir);
    }
    [posX, posY] = clampPos(event.clientX - dragOffsetX, event.clientY - dragOffsetY);
    applyPosition();
  }

  function onPointerUp(event) {
    if (!dragging) return;
    dragging = false;
    try { el.releasePointerCapture(event.pointerId); } catch (e) { /* 忽略 */ }
    el.classList.remove('codex-roam-pet-held');
    [posX, posY] = clampPos(posX ?? event.clientX - dragOffsetX, posY ?? event.clientY - dragOffsetY);
    applyPosition();
    if (onPositionChange) onPositionChange({ x: Math.round(posX), y: Math.round(posY) });
    if (reduced) return;
    playChain(['jumping']); // 落地跳一下，之后按最新状态回基底
  }

  function onResize() {
    if (posX !== null) {
      [posX, posY] = clampPos(posX, posY);
      applyPosition();
    }
  }

  /* ---------- 环视（仅 v2 图集）：指针接近时转头注视 ---------- */

  const lookEnabled = opts?.look?.enabled === true && rows >= 11 && !reduced;
  const lookRadius = Number.isFinite(opts?.look?.radius) && opts.look.radius > 0
    ? opts.look.radius
    : 500;
  let lookActive = false;
  let lookThrottleTs = 0;
  let lookTrailTimer = null;
  let lookLastEvent = null;

  // 罗盘方位角约定（v2 环视行实测标定）：0°=正上方，顺时针；16 方向每 22.5° 一帧，
  // row 9 覆盖 0°-157.5°，row 10 覆盖 180°-337.5°
  function lookFrame(dx, dy) {
    const bearing = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
    const d = Math.round(bearing / 22.5) % 16;
    return d < 8 ? { row: 9, col: d } : { row: 10, col: d - 8 };
  }

  function lookOff() {
    if (!lookActive) return;
    lookActive = false;
    // 基底循环被暂停过才恢复；被一次性动作/新状态打断时由它们自己接管
    if (current === base && !timerActive) enter(base, { loop: true });
  }

  function onMouseMove(event) {
    // 节流 + 尾帧补偿：被节流丢弃的最后一次移动会在 80ms 内补处理，
    // 否则指针停下时的最终角度/退出判定会丢
    lookLastEvent = event;
    const wait = 80 - (performance.now() - lookThrottleTs);
    if (wait > 0) {
      if (!lookTrailTimer) {
        lookTrailTimer = setTimeout(() => {
          lookTrailTimer = null;
          lookThrottleTs = performance.now();
          if (lookLastEvent) handleLook(lookLastEvent);
        }, wait);
      }
      return;
    }
    lookThrottleTs = performance.now();
    handleLook(event);
  }

  function handleLook(event) {
    const rect = el.getBoundingClientRect();
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 2);
    const dist = Math.hypot(dx, dy);
    // 仅 idle 基底循环中、未拖拽、未定格时可环视；进入/退出用滞后区间防抖
    const eligible = base === 'idle' && current === base && loopCurrent && !dragging && !frozen;
    if (eligible && (lookActive ? dist <= lookRadius + 50 : dist <= lookRadius)) {
      if (!lookActive) {
        lookActive = true;
        if (timer) clearTimeout(timer);
        timerActive = false; // 暂停 idle 播放，改由角度驱动
      }
      const f = lookFrame(dx, dy);
      el.style.backgroundPosition = `${-f.col * CELL_W * scale}px ${-f.row * CELL_H * scale}px`;
    } else {
      lookOff();
    }
  }

  function onDocMouseLeave() {
    lookOff();
  }

  /* ---------- 启动与销毁 ---------- */

  el.addEventListener('pointerenter', onPointerEnter);
  el.addEventListener('pointerleave', onPointerLeave);
  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('pointerup', onPointerUp);
  el.addEventListener('pointercancel', onPointerUp);
  window.addEventListener('resize', onResize);
  if (lookEnabled) {
    window.addEventListener('mousemove', onMouseMove);
    document.documentElement.addEventListener('mouseleave', onDocMouseLeave);
  }

  if (reduced) {
    // 减弱动态：官方约定静态显示 idle 第一帧
    current = 'idle';
    frame = 0;
    showFrame();
  } else {
    enter(base, { loop: true }); // 官方无登场动作：直接进入 idle 基底
  }

  function destroy() {
    if (timer) clearTimeout(timer);
    if (lookTrailTimer) clearTimeout(lookTrailTimer);
    if (hoverDwellTimer) clearTimeout(hoverDwellTimer);
    timerActive = false;
    el.removeEventListener('pointerenter', onPointerEnter);
    el.removeEventListener('pointerleave', onPointerLeave);
    el.removeEventListener('pointerdown', onPointerDown);
    el.removeEventListener('pointermove', onPointerMove);
    el.removeEventListener('pointerup', onPointerUp);
    el.removeEventListener('pointercancel', onPointerUp);
    window.removeEventListener('resize', onResize);
    if (lookEnabled) {
      window.removeEventListener('mousemove', onMouseMove);
      document.documentElement.removeEventListener('mouseleave', onDocMouseLeave);
    }
    el.remove();
  }

  return { el, setStatus, destroy };
}

const CodexRoamPet = { create, STATES };

export { create, STATES, CodexRoamPet };
