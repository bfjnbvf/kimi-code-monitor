/**
 * 新会话自动命名板块：官方实验开启引导。
 *
 * 标题自动生成由 Kimi CLI 官方实验 auto_session_title 承担（web 第一轮结束
 * 即自动生成，右键「生成标题」可手动触发）。本板块不再自行生成——点击
 * 「复制提示词」把一段交给 kimi 执行的配置提示词复制到剪贴板，用户粘贴到
 * kimi web 对话框发送，由 kimi 修改 ~/.kimi-code/config.toml 并提示 /reload。
 */
import { t } from '../i18n.js';

const copyBtn = document.getElementById('rename-copy-prompt');

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

if (copyBtn) copyBtn.addEventListener('click', copyPrompt);
