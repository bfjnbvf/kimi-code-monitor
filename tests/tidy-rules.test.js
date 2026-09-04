// 自动整理判定纯函数（src/tidy-rules.js）：三档规则、五条护栏、阈值边界与脏数据。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyTidyCandidates,
  normalizeTidySession,
  defaultTidyThresholds,
  SINGLE_DAY_SPAN_DAYS
} from '../src/tidy-rules.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-04T12:00:00Z');

// 构造 V1 形态条目：createdAtDaysAgo / updatedAtDaysAgo 相对 NOW
function session(overrides = {}) {
  const {
    id = 'session_a',
    title = '标题',
    createdAtDaysAgo = 10,
    updatedAtDaysAgo = 10,
    ...rest
  } = overrides;
  return {
    id,
    title,
    created_at: NOW - createdAtDaysAgo * DAY,
    updated_at: NOW - updatedAtDaysAgo * DAY,
    last_prompt: '帮我写一版摘要',
    ...rest
  };
}

test('单日对话：跨度 < 2 天且静默 ≥ 3 天命中 single-day', () => {
  const { candidates } = classifyTidyCandidates([session({ createdAtDaysAgo: 5, updatedAtDaysAgo: 4 })], NOW);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].rule, 'single-day');
  assert.equal(candidates[0].id, 'session_a');
});

test('多日对话：跨度 ≥ 2 天需静默 ≥ 14 天；「每隔几天回访」的会话不命中', () => {
  // 跨度 10 天、静默 4 天：有回访史且不算凉 → 不整理
  const warm = classifyTidyCandidates([session({ createdAtDaysAgo: 10, updatedAtDaysAgo: 4 })], NOW);
  assert.equal(warm.candidates.length, 0);
  // 同样跨度，静默 14 天 → 命中 multi-day
  const cold = classifyTidyCandidates([session({ createdAtDaysAgo: 20, updatedAtDaysAgo: 14 })], NOW);
  assert.equal(cold.candidates.length, 1);
  assert.equal(cold.candidates[0].rule, 'multi-day');
});

test('跨度分界：恰好 2 天归多日档，恰好不足 2 天归单日档', () => {
  const exactTwo = classifyTidyCandidates(
    [session({ createdAtDaysAgo: 16, updatedAtDaysAgo: 14 })],
    NOW
  );
  assert.equal(exactTwo.candidates[0].rule, 'multi-day');
  const justUnder = classifyTidyCandidates(
    [session({ createdAtDaysAgo: 14 + SINGLE_DAY_SPAN_DAYS - 0.1, updatedAtDaysAgo: 14 })],
    NOW
  );
  assert.equal(justUnder.candidates[0].rule, 'single-day');
});

test('静默分界：恰好达到阈值即命中（>= 语义）', () => {
  const exact = classifyTidyCandidates([session({ createdAtDaysAgo: 3.5, updatedAtDaysAgo: 3 })], NOW);
  assert.equal(exact.candidates[0].rule, 'single-day');
  const short = classifyTidyCandidates([session({ createdAtDaysAgo: 3.5, updatedAtDaysAgo: 2.9 })], NOW);
  assert.equal(short.candidates.length, 0);
});

test('兜底档：默认阈值下被更具体档位先命中，T1/T2 调大后才由 all 兜底', () => {
  // 跨度 29 天、静默 31 天：默认阈值下命中 multi-day（更具体的档位优先）
  const defaults = classifyTidyCandidates([session({ createdAtDaysAgo: 60, updatedAtDaysAgo: 31 })], NOW);
  assert.equal(defaults.candidates[0].rule, 'multi-day');
  // T1/T2 都调到 45/60 后，同一会话由 all 档兜底
  const fallback = classifyTidyCandidates(
    [session({ createdAtDaysAgo: 60, updatedAtDaysAgo: 31 })],
    NOW,
    { singleDayIdleDays: 45, multiDayIdleDays: 60 }
  );
  assert.equal(fallback.candidates[0].rule, 'all');
});

test('护栏：busy / 等待交互 / 已归档 / 子会话 / 空会话 / 新会话全跳过', () => {
  const guarded = [
    session({ id: 'busy', busy: true }),
    session({ id: 'turn-active', main_turn_active: true }),
    session({ id: 'approval', pending_interaction: 'approval' }),
    session({ id: 'archived', archived: true }),
    session({ id: 'child', metadata: { parent_session_id: 'session_parent' } }),
    session({ id: 'empty', last_prompt: '' }),
    session({ id: 'fresh', createdAtDaysAgo: 0.5, updatedAtDaysAgo: 0.4 })
  ];
  const { candidates } = classifyTidyCandidates(guarded, NOW);
  assert.deepEqual(candidates, []);
});

test('脏数据：缺 id / 缺时间戳 / updatedAt 早于 createdAt 一律跳过', () => {
  const dirty = [
    session({ id: '' }),
    session({ id: 'no-updated', updated_at: undefined }),
    session({ id: 'reversed', createdAtDaysAgo: 1, updatedAtDaysAgo: 5 }),
    session({ id: 'ok', createdAtDaysAgo: 25, updatedAtDaysAgo: 20 })
  ];
  const { candidates } = classifyTidyCandidates(dirty, NOW);
  assert.deepEqual(candidates.map((c) => c.id), ['ok']);
});

test('V2 原始形态（meta.* / activity.status）与 V1 包装形态判定一致', () => {
  const v2 = {
    id: 'session_v2',
    title: 'V2 会话',
    meta: {
      created_at: NOW - 20 * DAY,
      updated_at: NOW - 14 * DAY,
      archived: false,
      last_prompt: '继续'
    },
    metadata: {},
    activity: { status: 'idle' }
  };
  const v1 = {
    id: 'session_v1',
    title: 'V1 会话',
    created_at: NOW - 20 * DAY,
    updated_at: NOW - 14 * DAY,
    archived: false,
    last_prompt: '继续'
  };
  const { candidates } = classifyTidyCandidates([v2, v1], NOW);
  assert.deepEqual(candidates.map((c) => c.rule), ['multi-day', 'multi-day']);

  // V2 running 状态不整理
  const running = structuredClone(v2);
  running.id = 'session_running';
  running.activity.status = 'running';
  assert.deepEqual(classifyTidyCandidates([running], NOW).candidates, []);
});

test('阈值可调：自定义阈值生效，非法值回落默认并收敛到 1–365', () => {
  const custom = classifyTidyCandidates(
    [session({ createdAtDaysAgo: 3.5, updatedAtDaysAgo: 2 })],
    NOW,
    { singleDayIdleDays: 2 }
  );
  assert.equal(custom.candidates.length, 1);

  assert.deepEqual(defaultTidyThresholds(), { singleDayIdleDays: 3, multiDayIdleDays: 14, allIdleDays: 30 });
  const clamped = classifyTidyCandidates(
    [session({ createdAtDaysAgo: 400, updatedAtDaysAgo: 300 })],
    NOW,
    { singleDayIdleDays: 400, multiDayIdleDays: 400, allIdleDays: 9999 }
  );
  // 三档全部收敛到 365 → 300 天静默不命中任何档
  assert.deepEqual(clamped.candidates, []);
});

test('normalizeTidySession：时间支持 ISO 字符串，非法时间返回 null', () => {
  const normalized = normalizeTidySession({
    id: 's',
    created_at: '2026-08-01T00:00:00Z',
    updated_at: 'not-a-date',
    meta: { archived: true }
  });
  assert.equal(normalized.createdAt, Date.parse('2026-08-01T00:00:00Z'));
  assert.equal(normalized.updatedAt, null);
  assert.equal(normalized.archived, true);
  assert.equal(normalized.hasPrompt, false);
});

test('批量输入：候选与总数解耦，输出按输入顺序', () => {
  const { candidates } = classifyTidyCandidates(
    [
      session({ id: 'b', updatedAtDaysAgo: 20, createdAtDaysAgo: 25 }),
      session({ id: 'a-kept', updatedAtDaysAgo: 1 }),
      session({ id: 'c', updatedAtDaysAgo: 40, createdAtDaysAgo: 41 })
    ],
    NOW
  );
  assert.deepEqual(candidates.map((c) => c.id), ['b', 'c']);
});
