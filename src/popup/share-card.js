/**
 * 用量分享卡片板块：按钮入口、预览弹层、PNG 下载与剪贴板复制。
 * 卡片构图本身在 src/share-card.js（纯函数），这里只负责取数与导出。
 */
import { buildShareCardSvg, CARD_WIDTH, CARD_HEIGHT } from '../share-card.js';
import * as KimiCliUsage from '../cli-usage.js';
import { usageDayKey } from '../metrics.js';
import { BLOB_URL_REVOKE_MS, UI_MESSAGE_RESET_MS } from './shared.js';
import { t } from '../i18n.js';

const PNG_SCALE = 2; // 导出 2160×2700，社交平台上保持清晰

const openBtn = document.getElementById('share-card-btn');
const overlay = document.getElementById('share-card-overlay');
const previewImg = document.getElementById('share-card-preview');
const downloadBtn = document.getElementById('share-card-download');
const copyBtn = document.getElementById('share-card-copy');
const closeBtn = document.getElementById('share-card-close');
const statusEl = document.getElementById('share-card-status');

// 当前打开的卡片段落：关闭弹层时释放 blob URL
let current = null;

function setStatus(text) {
  statusEl.textContent = text;
  if (!text) return;
  setTimeout(() => {
    if (statusEl.textContent === text) statusEl.textContent = '';
  }, UI_MESSAGE_RESET_MS);
}

function closeCard() {
  overlay.classList.add('hidden');
  if (current?.svgUrl) URL.revokeObjectURL(current.svgUrl);
  current = null;
}

async function openCard() {
  openBtn.disabled = true;
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
    closeCard();
    current = { svg, startKey, endKey, svgUrl: null };
    current.svgUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    previewImg.src = current.svgUrl;
    statusEl.textContent = '';
    overlay.classList.remove('hidden');
  } catch (error) {
    console.warn('[Kimi Popup] 分享卡片生成失败', error);
  } finally {
    openBtn.disabled = false;
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

downloadBtn.addEventListener('click', async () => {
  if (!current) return;
  downloadBtn.disabled = true;
  try {
    const blob = await rasterize(current.svg);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `kimi-usage-${current.startKey}_${current.endKey}.png`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), BLOB_URL_REVOKE_MS);
    setStatus(t('已下载 ✓'));
  } catch (error) {
    setStatus(t('下载失败'));
  } finally {
    downloadBtn.disabled = false;
  }
});

copyBtn.addEventListener('click', async () => {
  if (!current) return;
  copyBtn.disabled = true;
  try {
    const blob = await rasterize(current.svg);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    setStatus(t('已复制 ✓'));
  } catch (error) {
    setStatus(t('复制失败，请用下载'));
  } finally {
    copyBtn.disabled = false;
  }
});

openBtn.addEventListener('click', openCard);
closeBtn.addEventListener('click', closeCard);
overlay.addEventListener('click', (event) => {
  if (event.target === overlay) closeCard();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && current) closeCard();
});
