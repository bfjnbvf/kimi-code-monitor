/* 会话智能命名：取样、标题清洗、守卫等纯函数。
 * content（rename-content.js）与 background（importScripts）共用，Node 测试直接 require。
 * 无任何 chrome / DOM 依赖。 */
'use strict';

/* ---------- 上下文取样限额（自动/批量共用一条管线） ----------
 * 单条消息 ≤300（超出保留前 200 + 后 100），尾部累计 ≤1000，
 * 头部（首条 user 消息）≤600，上下文总硬上限 1600；
 * prompt 模板约 300 字符，单次请求总输入 ≤2000。 */
const PER_MESSAGE_LIMIT = 300;
const PER_MESSAGE_HEAD = 200;
const PER_MESSAGE_TAIL = 100;
const TAIL_TOTAL_LIMIT = 1000;
const HEAD_LIMIT = 600;
const CONTEXT_TOTAL_LIMIT = 1600;
// 标题硬截断：规范是中文 12~20 字 / 英文 3~7 词，超出按超长兜底
const TITLE_MAX_CHARS = 32;

// 只留 user/assistant 的 text 片段；thinking/tool_use/tool_result 与 role=tool 一律丢弃
function messageText(message) {
  if (message?.role !== 'user' && message?.role !== 'assistant') return '';
  const parts = Array.isArray(message.content) ? message.content : [];
  return parts
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function truncateMessage(text) {
  if (text.length <= PER_MESSAGE_LIMIT) return text;
  return `${text.slice(0, PER_MESSAGE_HEAD)}…${text.slice(text.length - PER_MESSAGE_TAIL)}`;
}

/* 从消息列表构建命名上下文：
 * 返回 { head, tail, firstUserText, text }；
 * 可选传入 firstUserText（真实首条 user 消息，由 before_id 锚点单独拉取）——
 * 提供时头部用它；未提供时从当前消息页内推导（页只覆盖尾部时头部为空）。
 * firstUserText 始终返回真实/推导的首条 user 消息（截到 600），供启发式比对。 */
function buildRenameContext(messages, { firstUserText: providedFirstUserText = '' } = {}) {
  const entries = (Array.isArray(messages) ? messages : [])
    .map((message) => ({ role: message?.role, text: messageText(message) }))
    .filter((entry) => entry.text);
  if (!entries.length) return { head: '', tail: '', firstUserText: providedFirstUserText, text: '' };

  // 尾部：从最后一条往前整条累积，超出 1000 即止（至少保留最后一条）
  const tailParts = [];
  let tailLength = 0;
  let tailStartIndex = entries.length;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const part = truncateMessage(entries[index].text);
    const extra = tailParts.length ? part.length + 1 : part.length;
    if (tailParts.length && tailLength + extra > TAIL_TOTAL_LIMIT) break;
    tailParts.unshift(part);
    tailLength += extra;
    tailStartIndex = index;
  }

  // 头部：首条 user 消息 ≤600；尾部已覆盖它（短会话或页内可推导）则跳过
  const firstUserIndex = entries.findIndex((entry) => entry.role === 'user');
  const derivedFirstUserText = firstUserIndex >= 0 ? entries[firstUserIndex].text : '';
  const firstUserText = providedFirstUserText || derivedFirstUserText;
  let head = '';
  if (firstUserText) {
    // 消息页已覆盖会话开头（页内首条 user 与真实首条一致）时不重复头部
    const pageCoversStart = derivedFirstUserText && derivedFirstUserText === providedFirstUserText;
    const derivedIsStart = !providedFirstUserText && firstUserIndex < tailStartIndex;
    if (derivedIsStart || (providedFirstUserText && !pageCoversStart)) {
      head = firstUserText.slice(0, HEAD_LIMIT);
      if (firstUserText.length > HEAD_LIMIT) head += '…';
      // 上下文总硬上限 1600：超出时砍头部，尾部（最近内容）优先保留
      const headBudget = CONTEXT_TOTAL_LIMIT - tailLength - 1;
      if (head.length > headBudget) head = head.slice(0, Math.max(0, headBudget));
    }
  }

  const text = head ? `${head}\n…\n${tailParts.join('\n')}` : tailParts.join('\n');
  return { head, tail: tailParts.join('\n'), firstUserText, text };
}

/* ---------- 命名 prompt ----------
 * 模板本身约 300 字符，加 1600 上下文后单次请求 ≤2000。 */
function buildRenamePrompt(context, { withEmoji = true } = {}) {
  const output = withEmoji
    ? '只输出 JSON：{"emoji":"🐛","title":"标题"}，emoji 选一个贴切的，不要输出任何其他内容。'
    : '只输出 JSON：{"title":"标题"}，不要输出任何其他内容。';
  return [
    '为以下编程会话生成简短标题。要求：与对话主语言一致；中文 12~20 字，英文 3~7 个词；',
    '概括会话的核心任务；无结尾标点、无引号、无 markdown；避免"代码修改""帮助请求"这类空泛词。',
    '好例子：修复登录按钮移动端样式 / 为报表接口补充分页参数 / 排查定时任务偶发失败。',
    '坏例子：代码修改 / 用户求助 / 一个问题。',
    output,
    '',
    '会话内容：',
    context
  ].join('\n');
}

/* ---------- 标题清洗（解析失败/超长的兜底） ---------- */

function isEmoji(text) {
  return /^[\p{Extended_Pictographic}\uFE0F\u200D]+$/u.test(text);
}

// 去引号、去 markdown、折叠空白、去结尾标点、超长截断
function cleanTitleText(value) {
  let text = String(value || '').trim();
  text = text.replace(/^[#>*`\s]+/, '');
  text = text.replace(/\s+/g, ' ').trim();
  // 引号与结尾标点可能交替出现（如「标题」！），循环剥到稳定
  let previous;
  do {
    previous = text;
    text = text.replace(/[。！？!?，,、；;：:．.\s]+$/, '');
    text = text.replace(/^["'「」『』《》“”‘’]+/, '').replace(/["'「」『』《》“”‘’]+$/, '');
  } while (text !== previous);
  if (text.length > TITLE_MAX_CHARS) {
    text = text.slice(0, TITLE_MAX_CHARS).replace(/[。！？!?，,、；;：:．.\s]+$/, '');
  }
  return text;
}

/* 模型原始输出 → 写回用的最终标题（emoji 在前，空格分隔）。
 * JSON 解析失败时把全文当标题兜底；完全无法产出时返回 ''。 */
function sanitizeTitle(raw, { withEmoji = true } = {}) {
  let text = String(raw || '').trim();
  if (!text) return '';
  // 剥 markdown 代码围栏（模型常见包装）
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  let emoji = '';
  let title = '';
  // 宽容截取第一个 { 到最后一个 } 尝试 JSON 解析
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  let parsed = null;
  if (start >= 0 && end > start) {
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch (error) {
      parsed = null;
    }
  }
  if (parsed) {
    // 解析出 JSON 但没有合法 title 字段：视为失败，不把 JSON 原文当标题
    title = typeof parsed.title === 'string' ? parsed.title : '';
    if (typeof parsed.emoji === 'string') emoji = parsed.emoji.trim();
  } else {
    title = text;
  }

  title = cleanTitleText(title);
  if (!title) return '';
  if (!withEmoji || !isEmoji(emoji)) emoji = '';
  return emoji ? `${emoji} ${title}` : title;
}

/* ---------- 自动标题启发式 ----------
 * title 与首条 user 消息互为前缀（忽略尾部省略号/截断、忽略全部空白差异）视为
 * 自动标题，可处理；不一致视为用户手动改过，跳过。
 * 两个特例：title 中敏感路径被打码为 [redacted]（按通配符比对）；
 * 斜杠命令会话（标题 /cmd，首条是 "User activated the skill" 激活文本）。 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function looksLikeAutoTitle(title, firstUserText) {
  // 服务端生成自动标题时会折叠/增删空白，比对时剥掉所有空白与尾部省略号
  const normalize = (value) => String(value || '').replace(/[….\s]+$/, '').replace(/\s+/g, '');
  const current = normalize(title);
  const first = normalize(firstUserText);
  if (!current || !first) return false;
  // 斜杠命令会话：标题是命令名，首条消息是技能激活文本
  const trimmedTitle = String(title || '').trim();
  if (/^\/[\w-]+$/.test(trimmedTitle) && String(firstUserText || '').includes(trimmedTitle.slice(1))) {
    return true;
  }
  // 服务端对 title 中的敏感路径打码为 [redacted]：按通配符比对
  if (current.includes('[redacted]')) {
    // 打码段在原文里可能很长（如 attachments 路径），通配跨度放宽到 200
    const pattern = current.split('[redacted]').map(escapeRegExp).join('.{0,200}?');
    return new RegExp(`^${pattern}`).test(first);
  }
  // 完全相等（忽略省略/空白）→ 自动标题
  if (current === first) return true;
  // 标题以省略/截断结尾，且剥掉后仍是首条前缀 → 仅差尾部截断，判自动
  if (/[….\s]+$/.test(String(title || '')) && first.startsWith(current)) return true;
  // 前缀关系：要求首条消息明显更长，否则视为用户手动改成前缀的标题
  const firstIsLonger = first.length >= current.length * 2 || first.length - current.length >= 8;
  if (first.startsWith(current) && firstIsLonger) return true;
  // 长标题的头部 40 字前缀仍与首条一致，且首条更长
  if (current.length > 40 && first.startsWith(current.slice(0, 40)) && firstIsLonger) return true;
  return false;
}

/* ---------- 跳过规则（满足任一即跳过，返回原因；可处理返回 ''） ---------- */
function skipSessionReason(session, { renameLog = {}, customTitleIds = null } = {}) {
  if (!session || typeof session.id !== 'string' || !session.id) return 'no-id';
  if (session.busy === true) return 'busy';
  if (session.archived === true) return 'archived';
  // 注意：列表接口的 message_count 恒为 0（非真实计数），不能据此判空；
  // 空对话在拉取消息后由 context.text 为空判定
  if (renameLog[session.id]) return 'already-renamed';
  // 权威依据：CLI state.json 的 isCustomTitle（由 popup 在批量启动时收集）
  if (customTitleIds && customTitleIds.has(session.id)) return 'custom-title';
  return '';
}

/* ---------- 命名模型来源 ----------
 * modelSource 结构：{ kind:'kimi-code', model } 或 { kind:'external', accountId }。
 * 旧版字符串值（'kimi' / 'ext:<id>'）读取时迁移；'kimi' 一律落到默认模型。 */
const KIMI_CODE_MODELS_PROVIDER = 'managed:kimi-code';
// 默认用 K2.7 Coding（单价更低）；Highspeed 更快但更贵，留给用户手动选
const DEFAULT_KIMI_CODE_MODEL = 'kimi-code/kimi-for-coding';
// 本地服务 /api/v1/models 不可用时的硬编码兜底（与线上四项一致，默认模型居首）
const KIMI_CODE_FALLBACK_MODELS = [
  { model: 'kimi-code/kimi-for-coding', display_name: 'K2.7 Coding' },
  { model: 'kimi-code/kimi-for-coding-highspeed', display_name: 'K2.7 Coding Highspeed' },
  { model: 'kimi-code/k3', display_name: 'K3' },
  { model: 'kimi-code/k3-256k', display_name: 'K3-256k' }
];

function defaultModelSource() {
  return { kind: 'kimi-code', model: DEFAULT_KIMI_CODE_MODEL };
}

function normalizeModelSource(value) {
  if (value && typeof value === 'object') {
    if (value.kind === 'kimi-code' && typeof value.model === 'string' && value.model) {
      return { kind: 'kimi-code', model: value.model };
    }
    if (value.kind === 'external' && typeof value.accountId === 'string' && value.accountId) {
      // model 可选：缺省时由 provider 兜底默认模型
      const model = typeof value.model === 'string' && value.model ? value.model : undefined;
      return model ? { kind: 'external', accountId: value.accountId, model } : { kind: 'external', accountId: value.accountId };
    }
    return defaultModelSource();
  }
  // 旧版字符串：'ext:<id>' 为外部账户，'kimi' 及其余一律默认 Kimi Code 模型
  if (typeof value === 'string' && value.startsWith('ext:') && value.length > 4) {
    return { kind: 'external', accountId: value.slice(4) };
  }
  return defaultModelSource();
}

// 从 /api/v1/models 的 items 里筛出 Kimi Code 模型（保序），display_name 缺省回退 model id
function kimiCodeModelsFromResponse(items) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item?.provider === KIMI_CODE_MODELS_PROVIDER && typeof item.model === 'string' && item.model)
    .map((item) => ({
      model: item.model,
      display_name: typeof item.display_name === 'string' && item.display_name ? item.display_name : item.model
    }));
}

const KimiSessionRename = {
  PER_MESSAGE_LIMIT,
  TAIL_TOTAL_LIMIT,
  HEAD_LIMIT,
  CONTEXT_TOTAL_LIMIT,
  TITLE_MAX_CHARS,
  KIMI_CODE_MODELS_PROVIDER,
  DEFAULT_KIMI_CODE_MODEL,
  KIMI_CODE_FALLBACK_MODELS,
  defaultModelSource,
  normalizeModelSource,
  kimiCodeModelsFromResponse,
  messageText,
  buildRenameContext,
  buildRenamePrompt,
  isEmoji,
  sanitizeTitle,
  looksLikeAutoTitle,
  skipSessionReason
};

export {
  PER_MESSAGE_LIMIT,
  TAIL_TOTAL_LIMIT,
  HEAD_LIMIT,
  CONTEXT_TOTAL_LIMIT,
  TITLE_MAX_CHARS,
  KIMI_CODE_MODELS_PROVIDER,
  DEFAULT_KIMI_CODE_MODEL,
  KIMI_CODE_FALLBACK_MODELS,
  defaultModelSource,
  normalizeModelSource,
  kimiCodeModelsFromResponse,
  messageText,
  buildRenameContext,
  buildRenamePrompt,
  isEmoji,
  sanitizeTitle,
  looksLikeAutoTitle,
  skipSessionReason,
  KimiSessionRename
};
