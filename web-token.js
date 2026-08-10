/**
 * Kimi Web Token Relay
 *
 * 已停用：本文件未在 manifest.json 注册，当前不会注入任何页面；
 * 月额度通路保留备用，重新启用需在 manifest 补本文件的 content_scripts
 * 与 https://www.kimi.com/* 的 host_permissions。
 *
 * 月额度（GetSubscriptionStats）只认 kimi.com 网页端的 access_token，
 * 扩展的设备 OAuth token 调它会 401。本脚本注入 www.kimi.com 页面，
 * 读取网页端 localStorage 的 access_token 并上报 background 缓存。
 * 为把注入开销降到最低：只在 token 变化时上报，加载/回前台时各检查一次。
 */
(function () {
  'use strict';

  let lastReported = '';

  function jwtExp(token) {
    try {
      const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return Number.isFinite(payload?.exp) ? payload.exp : 0;
    } catch (error) {
      return 0;
    }
  }

  function report() {
    try {
      const token = localStorage.getItem('access_token');
      if (!token || token === lastReported) return;
      lastReported = token;
      chrome.runtime
        .sendMessage({
          type: 'webtoken.report',
          payload: { token, expiresAt: jwtExp(token) }
        })
        .catch(() => {
          // 上报失败时下轮允许重试
          lastReported = '';
        });
    } catch (error) {
      // localStorage 或 runtime 不可用时静默跳过
    }
  }

  report();
  // token 会被 web 端静默刷新轮换：回到前台时补一次检查
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') report();
  });
  window.addEventListener('focus', report);
})();
