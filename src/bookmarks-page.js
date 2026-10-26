/**
 * 收藏页（扩展自有标签页）
 *
 * 收藏正文不再渲染进宿主页面：页面脚本拿不到这里的 DOM。「跳转到原文」通过
 * 后台转给已授权的 Kimi Web 标签页，由内容脚本执行滚动定位。
 */

import { initPopupLocale, t } from './i18n.js';
import { mountBookmarksPage } from './content/bookmarks.js';

async function main() {
  await initPopupLocale();
  document.title = `${t('收藏')} · Kimi Code Monitor`;

  const toast = document.getElementById('kbm-toast');
  let toastTimer = null;
  function notify(text) {
    if (!toast) return;
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, 2800);
  }

  await mountBookmarksPage({
    jump: async (sessionId, turnId) => {
      const response = await chrome.runtime
        .sendMessage({ type: 'bookmarks.jump', payload: { sessionId, turnId } })
        .catch(() => null);
      if (!response?.ok) notify(response?.error || t('没有打开的 Kimi Web 页面'));
    }
  });
}

main().catch((error) => {
  console.error('[Kimi Status] 收藏页加载失败', error);
});
