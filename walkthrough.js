/* 分步新手引导：高亮目标元素 + 气泡说明 + 箭头指向。
   不依赖 chrome API：步骤、锚点与结束回调全部由调用方（content.js / 预览页）提供。 */
(function () {
  'use strict';

  let root = null;
  let state = null;

  function start(options) {
    if (root) return;
    // 锚点元素不存在（模块被隐藏等）的步骤直接跳过
    const steps = (options.steps || []).filter((step) => {
      try {
        return typeof step.anchor === 'function' && Boolean(step.anchor());
      } catch (error) {
        return false;
      }
    });
    if (!steps.length) {
      options.onSkip?.();
      return;
    }
    state = {
      steps,
      index: Math.min(options.startIndex || 0, steps.length - 1),
      onFinish: options.onFinish,
      onSkip: options.onSkip
    };

    root = document.createElement('div');
    root.id = 'ksb-walk';
    root.innerHTML = `
      <div class="ksb-walk-spot"></div>
      <div class="ksb-walk-bubble" role="dialog" aria-live="polite">
        <div class="ksb-walk-step"></div>
        <div class="ksb-walk-title"></div>
        <div class="ksb-walk-body"></div>
        <div class="ksb-walk-foot">
          <button type="button" class="ksb-walk-skip">跳过</button>
          <button type="button" class="ksb-walk-next"></button>
        </div>
      </div>`;
    document.body.appendChild(root);

    root.querySelector('.ksb-walk-next').addEventListener('click', next);
    root.querySelector('.ksb-walk-skip').addEventListener('click', skip);
    document.addEventListener('keydown', onKeydown, true);
    window.addEventListener('resize', layout);
    render();
  }

  function render() {
    const step = state.steps[state.index];
    root.querySelector('.ksb-walk-step').textContent = `${state.index + 1} / ${state.steps.length}`;
    root.querySelector('.ksb-walk-title').textContent = step.title;
    root.querySelector('.ksb-walk-body').innerHTML = step.bodyHTML;
    root.querySelector('.ksb-walk-next').textContent =
      state.index === state.steps.length - 1 ? step.doneLabel || '完成' : '下一步';
    layout();
  }

  // 气泡优先放目标右侧（面板在侧栏，右侧是页面主区），放不下再试左侧；
  // 垂直方向与目标居中对齐并夹在视口内，箭头始终指向目标中心
  function layout() {
    if (!root || !state) return;
    const target = state.steps[state.index].anchor();
    if (!target || !target.isConnected) return;
    const rect = target.getBoundingClientRect();
    const pad = 4;

    const spot = root.querySelector('.ksb-walk-spot');
    spot.style.left = `${rect.left - pad}px`;
    spot.style.top = `${rect.top - pad}px`;
    spot.style.width = `${rect.width + pad * 2}px`;
    spot.style.height = `${rect.height + pad * 2}px`;

    const bubble = root.querySelector('.ksb-walk-bubble');
    bubble.style.visibility = 'hidden';
    bubble.style.left = '0px';
    bubble.style.top = '0px';
    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;

    let left = rect.right + 14;
    let onRight = false;
    if (left + bw > window.innerWidth - 12) {
      left = Math.max(12, rect.left - 14 - bw);
      onRight = true;
    }
    const top = Math.max(12, Math.min(rect.top + rect.height / 2 - bh / 2, window.innerHeight - bh - 12));

    bubble.style.left = `${left}px`;
    bubble.style.top = `${top}px`;
    bubble.style.visibility = '';
    bubble.classList.toggle('ksb-walk-flip', onRight);
    // 箭头纵坐标：目标中心相对气泡顶部的位置，夹在气泡圆角之内
    const arrowY = Math.max(16, Math.min(rect.top + rect.height / 2 - top, bh - 16));
    bubble.style.setProperty('--ksb-walk-arrow-y', `${arrowY}px`);
  }

  function next() {
    if (state.index < state.steps.length - 1) {
      state.index += 1;
      render();
    } else {
      finish();
    }
  }

  function finish() {
    const callback = state?.onFinish;
    cleanup();
    callback?.();
  }

  function skip() {
    const callback = state?.onSkip;
    cleanup();
    callback?.();
  }

  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      skip();
    }
  }

  function cleanup() {
    document.removeEventListener('keydown', onKeydown, true);
    window.removeEventListener('resize', layout);
    root?.remove();
    root = null;
    state = null;
  }

  window.KsbWalkthrough = { start, stop: cleanup };
})();
