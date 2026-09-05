/**
 * 新会话自动命名板块：官方实验开启引导。
 *
 * 标题自动生成由 Kimi CLI 官方实验 auto_session_title 承担（web 第一轮结束
 * 即自动生成，右键「生成标题」可手动触发）。本板块不再自行生成——点击
 * 「复制提示词」把一段交给 kimi 执行的配置提示词复制到剪贴板，用户粘贴到
 * kimi web 对话框发送，由 kimi 修改 ~/.kimi-code/config.toml 并提示 /reload。
 *
 * 官方实验已开启时（内容脚本经 /api/v1/meta 探测），本子块整体隐藏，
 * 不再常驻弹窗。
 */
import { send } from './shared.js';
import { t } from '../i18n.js';

const copyBtn = document.getElementById('rename-copy-prompt');
const extRenameBlock = document.getElementById('ext-rename-block');
const extRenameDivider = document.getElementById('ext-rename-divider');
// 探测结果的持久缓存：只要探测到过「已开启」，之后每次打开弹窗都直接隐藏，
// 不依赖当时是否有打开的 Kimi 页面（重载扩展后页面内容脚本恢复前探测必失败）
const RENAME_OFFICIAL_CACHE_KEY = 'kimiOfficialAutoTitle';

// 交给 kimi 执行的提示词（用户审定文本，勿改动措辞）
const PROMPT = [
  '帮我修改 Kimi Code 的实验性功能开关：开启「AI 自动生成会话标题」（auto_session_title）。',
  '',
  '要求：',
  '1. 修改 ~/.kimi-code/config.toml（若设置了 KIMI_CODE_HOME 则以它为准），在 [experimental] 段下加一行 auto_session_title = true',
  '2. 不要直接改原文件：先复制为 config-new.toml，编辑副本，用 kimi doctor config 校验通过后再备份原文件（时间戳命名）并替换',
  '3. 不要动配置里的其他内容',
  '4. 改完告诉我运行 /reload 生效'
].join('\n');

function renderCopied() {
  const original = copyBtn.textContent;
  copyBtn.textContent = t('已复制，粘贴到 kimi 对话框发送即可');
  copyBtn.disabled = true;
  setTimeout(() => {
    copyBtn.textContent = original;
    copyBtn.disabled = false;
  }, 2_500);
}

async function copyPrompt() {
  try {
    await navigator.clipboard.writeText(PROMPT);
    renderCopied();
    return;
  } catch { /* 权限拒绝或非安全上下文：走 execCommand 降级 */ }
  const helper = document.createElement('textarea');
  helper.value = PROMPT;
  helper.style.cssText = 'position:fixed;opacity:0;';
  document.body.append(helper);
  helper.select();
  const ok = document.execCommand('copy');
  helper.remove();
  if (ok) {
    renderCopied();
  } else {
    copyBtn.textContent = t('复制失败，请手动操作');
    setTimeout(() => { copyBtn.textContent = t('复制提示词'); }, 2_500);
  }
}

// 探测官方实验状态：已开启则隐藏整个子块。
// 判定顺序：持久缓存（探测到过即真）→ 实时探测；实时探测失败（如没有打开的
// Kimi 页面）时保持现状，避免误隐藏。
async function refreshOfficialStatus() {
  if (!extRenameBlock) return;
  try {
    const cached = await chrome.storage.local.get(RENAME_OFFICIAL_CACHE_KEY);
    if (cached[RENAME_OFFICIAL_CACHE_KEY] === true) return hideRenameBlock();
  } catch { /* 读失败继续探测 */ }
  try {
    const response = await send('rename.official.status');
    if (response?.ok && response.enabled) {
      chrome.storage.local.set({ [RENAME_OFFICIAL_CACHE_KEY]: true }).catch(() => {});
      hideRenameBlock();
    }
  } catch { /* 无打开页面：保持显示 */ }
}

function hideRenameBlock() {
  extRenameBlock.classList.add('hidden');
  extRenameDivider?.classList.add('hidden');
}

if (copyBtn) copyBtn.addEventListener('click', copyPrompt);
refreshOfficialStatus();
