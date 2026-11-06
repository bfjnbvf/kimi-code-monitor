import test from 'node:test';
import assert from 'node:assert/strict';
import { monthlyQuota, isMonthlyPlan } from '../src/quota-plans.js';

const monthTotal = { usedRatio: 0.4988, resetAt: '2026-11-26T00:00:00Z' };
const monthCode = { usedRatio: 0.4046, resetAt: '2026-11-26T00:00:00Z' };

test('新套餐真实形状：monthTotal 优先，缺少周字段时判为月套餐', () => {
  const usages = {
    limit5h: { usedRatio: 0.128, resetAt: '2026-11-06T01:57:26Z' },
    monthTotal,
    monthCode
  };
  assert.deepEqual(monthlyQuota(usages), monthTotal);
  assert.equal(isMonthlyPlan(usages), true);
});

test('缺少 monthTotal 时回退 monthCode', () => {
  assert.deepEqual(monthlyQuota({ monthCode }), monthCode);
  assert.equal(isMonthlyPlan({ monthCode }), true);
});

test('旧套餐、月周并存、缺月字段和无效月比例都不会误判成新套餐', () => {
  assert.equal(isMonthlyPlan({ limit5h: {}, limit7d: { usedRatio: 0.2 } }), false);
  assert.equal(isMonthlyPlan({ limit7d: {}, monthTotal }), false);
  assert.equal(isMonthlyPlan({ limit_7d: {}, monthTotal }), false);
  assert.equal(isMonthlyPlan({ usage: {}, monthTotal }), false);
  assert.equal(isMonthlyPlan({ limit5h: {} }), false);
  for (const usedRatio of [undefined, '', 'invalid', -1]) {
    assert.equal(isMonthlyPlan({ monthTotal: { usedRatio } }), false);
  }
});
