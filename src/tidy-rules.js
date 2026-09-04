/* 自动整理「已完成」：判定纯函数（无 DOM / 无 chrome 依赖，tests 直接跑）。
 *
 * 输入是 kimi web 会话列表的原始条目。web 客户端存在两种形态：
 * - V1 包装（ju 解析）：顶层 created_at / updated_at / busy / pending_interaction / archived
 * - V2 原始（listSessionsV2 不做映射）：meta.created_at / meta.updated_at / meta.archived /
 *   meta.last_prompt，父子关系两种形态都在 metadata.parent_session_id
 * normalizeTidySession 统一归一化，classifyTidyCandidates 只吃归一化形态。
 */
'use strict';

const DAY_MS = 86_400_000;
// 判定为「单日对话」的活跃跨度上限（天）：活跃集中在 48 小时内
export const SINGLE_DAY_SPAN_DAYS = 2;
// 新会话保护窗：创建不满 24 小时的会话无论多冷都不整理
const NEW_SESSION_GRACE_MS = DAY_MS;

export function defaultTidyThresholds() {
  return { singleDayIdleDays: 3, multiDayIdleDays: 14, allIdleDays: 30 };
}

// 阈值容错：非有限数回落默认，范围收敛到 1–365
function normalizeThresholds(thresholds) {
  const defaults = defaultTidyThresholds();
  const clamp = (value, fallback) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(365, Math.max(1, Math.round(number)));
  };
  return {
    singleDayIdleDays: clamp(thresholds?.singleDayIdleDays, defaults.singleDayIdleDays),
    multiDayIdleDays: clamp(thresholds?.multiDayIdleDays, defaults.multiDayIdleDays),
    allIdleDays: clamp(thresholds?.allIdleDays, defaults.allIdleDays)
  };
}

// 时间字段兼容毫秒数与 ISO 字符串；非法返回 null
function parseTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function firstDefined(source, keys) {
  for (const key of keys) {
    if (source?.[key] != null) return source[key];
  }
  return undefined;
}

// 归一化列表条目；字段缺失/非法时布尔位一律 false（由护栏兜住）
export function normalizeTidySession(raw) {
  const meta = raw?.meta && typeof raw.meta === 'object' ? raw.meta : {};
  const activityStatus = String(firstDefined(raw, ['activity_status', 'status']) ?? raw?.activity?.status ?? '');
  const parentSessionId = firstDefined(raw?.metadata, ['parent_session_id'])
    ?? firstDefined(raw?.meta, ['parent_session_id'])
    ?? raw?.parentSessionId;
  const rawTitle = firstDefined(raw, ['title']) ?? meta.title;
  return {
    id: typeof raw?.id === 'string' ? raw.id : '',
    title: typeof rawTitle === 'string' ? rawTitle : '',
    createdAt: parseTime(firstDefined(raw, ['created_at']) ?? meta.created_at),
    updatedAt: parseTime(firstDefined(raw, ['updated_at']) ?? meta.updated_at),
    busy: raw?.busy === true || raw?.main_turn_active === true || activityStatus === 'running',
    pendingInteraction: Boolean(
      firstDefined(raw, ['pending_interaction', 'pendingInteraction']) ||
      activityStatus === 'approval' ||
      activityStatus === 'question'
    ),
    archived: (firstDefined(raw, ['archived']) ?? meta.archived) === true,
    hasParent: typeof parentSessionId === 'string',
    hasPrompt: String(firstDefined(raw, ['last_prompt']) ?? meta.last_prompt ?? '').length > 0
  };
}

/* 判定候选。返回 { candidates: [{id, title, idleDays, spanDays, rule}] }。
 * rule ∈ 'single-day' | 'multi-day' | 'all'，展示文案由调用方经 i18n 映射。
 * 护栏优先于规则：正在工作 / 等待交互 / 已归档 / 子会话 / 新会话 / 空会话 /
 * 脏数据（updatedAt < createdAt 或缺时间戳）一律跳过。 */
export function classifyTidyCandidates(sessions, now, thresholds) {
  const limits = normalizeThresholds(thresholds);
  const nowMs = Number.isFinite(now) ? now : Date.now();
  const candidates = [];
  for (const raw of Array.isArray(sessions) ? sessions : []) {
    const session = raw && typeof raw === 'object' && 'id' in raw && raw.updatedAt != null && typeof raw.busy === 'boolean'
      ? raw
      : normalizeTidySession(raw);
    if (!session.id || session.updatedAt == null) continue;
    if (session.archived || session.busy || session.pendingInteraction) continue;
    if (session.hasParent || !session.hasPrompt) continue;
    if (session.createdAt == null || session.updatedAt < session.createdAt) continue;
    if (nowMs - session.createdAt < NEW_SESSION_GRACE_MS) continue;

    const spanDays = (session.updatedAt - session.createdAt) / DAY_MS;
    const idleDays = (nowMs - session.updatedAt) / DAY_MS;
    let rule = null;
    if (spanDays < SINGLE_DAY_SPAN_DAYS && idleDays >= limits.singleDayIdleDays) {
      rule = 'single-day';
    } else if (spanDays >= SINGLE_DAY_SPAN_DAYS && idleDays >= limits.multiDayIdleDays) {
      rule = 'multi-day';
    } else if (idleDays >= limits.allIdleDays) {
      rule = 'all';
    }
    if (!rule) continue;
    candidates.push({
      id: session.id,
      title: session.title,
      idleDays: Math.round(idleDays * 10) / 10,
      spanDays: Math.round(spanDays * 10) / 10,
      rule
    });
  }
  return { candidates };
}
