/**
 * 独立 popup 页面入口（VibePal 右键下拉面板）
 *
 * 移植扩展的 popup.html + src/popup.js，差异：
 * - 数据不来自 chrome.* / 页面宿主：消耗量缓存经桥接写进 storage shim，
 *   外部账户抓取、宠物安装、导出/分享/打开 URL 全部桥接给 Swift 完成
 *   （webview 直连第三方 API 会被 CORS 挡，协议见 popup-app/shims.js）
 * - 保留板块：用量统计（usage.js 原样复用）、外部账户（external.js 原样复用）、
 *   桌面宠物（popup-app/pets.js，App 版重写）；Kimi 账户 / 扩展功能 /
 *   动态站点（hosts）板块用 class 隐藏，结构保留便于上游同步
 * - footer：导出统计/分享用量走桥接（NSSavePanel / 剪贴板），检查更新打开
 *   固定 URL，另加「退出 VibePal」（右键菜单已移除，原退出入口迁到这里）
 */

import './popup-app/shims.js';
import { installPopupBridge, markPopupBridgeReady } from './popup-app/bridge.js';
import { setCliPathHelp, refreshCliStatus } from './popup/usage.js';
import { buildExternalSection, refreshExternalStatus } from './popup/external.js';
import { loadPetSection } from './popup-app/pets.js';
import { buildShareCardSvg, CARD_WIDTH, CARD_HEIGHT } from './share-card.js';
import * as KimiCliUsage from './cli-usage.js';
import { usageDayKey } from './metrics.js';
import { initPopupLocale, applyPopupI18n, t } from './i18n.js';

const UI_MESSAGE_RESET_MS = 2_000;
const PNG_SCALE = 2; // 与扩展 share-card.js 一致：2160×2700
const UPDATE_URL = 'https://github.com/bfjnbvf/kimi-code-monitor/releases';

document.body.classList.add('is-popup');

function kick(promise) {
  Promise.resolve(promise).catch((error) => console.warn('[Kimi Popup] 初始化失败', error));
}

function ask(message) {
  return chrome.runtime.sendMessage(message);
}

/* ---------- footer：导出统计 / 分享用量 / 检查更新 / 退出 ---------- */

// usage.js 挂了自己的导出（blob 下载，WKWebView 里不可用）：
// 先克隆剥掉它的监听，再绑桥接版（NSSavePanel 写盘）
{
  const old = document.getElementById('export-link');
  const fresh = old.cloneNode(true);
  old.replaceWith(fresh);
  fresh.addEventListener('click', async (event) => {
    event.preventDefault();
    try {
      const response = await ask({ type: 'export.usage' });
      if (!response?.ok) throw new Error(response?.error || '');
    } catch (error) {
      setLinkMessage(fresh, t('导出失败'));
    }
  });
}

function setLinkMessage(link, text) {
  link.textContent = text;
  setTimeout(() => {
    if (link.textContent === text) link.textContent = t('导出统计');
  }, UI_MESSAGE_RESET_MS);
}

// 检查更新：固定 URL 交 Swift 用系统浏览器打开
document.querySelector('a[href*="releases"]').addEventListener('click', (event) => {
  event.preventDefault();
  ask({ type: 'open.url', payload: { url: UPDATE_URL } }).catch(() => {});
});

const quitLink = document.getElementById('quit-link');
quitLink.addEventListener('click', (event) => {
  event.preventDefault();
  ask({ type: 'quit' }).catch(() => {});
});

/* ---------- 分享用量：卡片预览 + PNG 下载/复制（桥接） ---------- */

const shareBtn = document.getElementById('share-card-btn');
const shareOverlay = document.getElementById('share-card-overlay');
const sharePreview = document.getElementById('share-card-preview');
const shareDownloadBtn = document.getElementById('share-card-download');
const shareCopyBtn = document.getElementById('share-card-copy');
const shareCloseBtn = document.getElementById('share-card-close');
const shareStatus = document.getElementById('share-card-status');

// 当前卡片：svg + 日期范围（生成 PNG 用），blob URL 关闭时释放
let currentCard = null;

function setShareStatus(text) {
  shareStatus.textContent = text;
  if (!text) return;
  setTimeout(() => {
    if (shareStatus.textContent === text) shareStatus.textContent = '';
  }, UI_MESSAGE_RESET_MS);
}

function closeShareCard() {
  shareOverlay.classList.add('hidden');
  if (currentCard?.svgUrl) URL.revokeObjectURL(currentCard.svgUrl);
  currentCard = null;
}

async function openShareCard() {
  shareBtn.disabled = true;
  try {
    const stored = await chrome.storage.local.get(KimiCliUsage.DAILY_STORAGE_KEY);
    const daily = stored[KimiCliUsage.DAILY_STORAGE_KEY] || {};
    const todayKey = usageDayKey(new Date());
    const firstKey = Object.keys(daily).sort()[0] || todayKey;
    // 沿用消耗量板块的日期范围（与按天统计同口径）；未选时兜底为全部记录
    const startValue = document.getElementById('usage-start').value;
    const endValue = document.getElementById('usage-end').value;
    const startKey = startValue && startValue <= (endValue || todayKey) ? startValue : firstKey;
    const endKey = endValue || todayKey;
    const svg = buildShareCardSvg({ daily, startKey, endKey });
    closeShareCard();
    currentCard = { svg, startKey, endKey, svgUrl: null };
    currentCard.svgUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    sharePreview.src = currentCard.svgUrl;
    shareStatus.textContent = '';
    shareOverlay.classList.remove('hidden');
  } catch (error) {
    console.warn('[Kimi Popup] 分享卡片生成失败', error);
    setShareStatus(t('卡片渲染失败'));
  } finally {
    shareBtn.disabled = false;
  }
}

// SVG → PNG Blob：同源无外部资源，canvas 不会被污染
function rasterize(svg) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      canvas.width = CARD_WIDTH * PNG_SCALE;
      canvas.height = CARD_HEIGHT * PNG_SCALE;
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('PNG 生成失败'))),
        'image/png'
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('卡片渲染失败'));
    };
    img.src = url;
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

shareBtn.addEventListener('click', (event) => {
  event.preventDefault();
  openShareCard();
});

shareDownloadBtn.addEventListener('click', async () => {
  if (!currentCard) return;
  shareDownloadBtn.disabled = true;
  try {
    const blob = await rasterize(currentCard.svg);
    const png = await blobToBase64(blob);
    const response = await ask({
      type: 'share.save',
      payload: {
        png,
        filename: `kimi-usage-${currentCard.startKey}_${currentCard.endKey}.png`
      }
    });
    setShareStatus(response?.ok ? t('已下载 ✓') : t('下载失败'));
  } catch (error) {
    setShareStatus(t('下载失败'));
  } finally {
    shareDownloadBtn.disabled = false;
  }
});

shareCopyBtn.addEventListener('click', async () => {
  if (!currentCard) return;
  shareCopyBtn.disabled = true;
  try {
    const blob = await rasterize(currentCard.svg);
    const png = await blobToBase64(blob);
    const response = await ask({ type: 'share.copy', payload: { png } });
    setShareStatus(response?.ok ? t('已复制 ✓') : t('复制失败，请用下载'));
  } catch (error) {
    setShareStatus(t('复制失败，请用下载'));
  } finally {
    shareCopyBtn.disabled = false;
  }
});

shareCloseBtn.addEventListener('click', closeShareCard);
shareOverlay.addEventListener('click', (event) => {
  if (event.target === shareOverlay) closeShareCard();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && currentCard) closeShareCard();
});

/* ---------- 装配 ---------- */

installPopupBridge();

// 语言跟随 kimi-locale（Swift 侧如需英文可预先写入该键）；缺省保持中文
try {
  if (localStorage.getItem('kimi-locale')) {
    initPopupLocale().then(() => applyPopupI18n(document)).catch(() => {});
  }
} catch (error) {
  // localStorage 不可用时保持默认中文
}

async function bootstrap() {
  // 桥接入口就绪：Swift 的 appInfo / usageDaily 推送开始入队生效前的落地
  markPopupBridgeReady();
  try {
    setCliPathHelp();
    kick(refreshCliStatus());
    buildExternalSection();
    kick(refreshExternalStatus());
    await loadPetSection();
  } catch (error) {
    console.warn('[Kimi Popup] 初始化失败', error);
  }
}

bootstrap();
