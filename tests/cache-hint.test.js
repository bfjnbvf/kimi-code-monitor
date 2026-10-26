import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';

import {
  CACHE_COLD_MS,
  CACHE_WARN_MS,
  cacheStageFor,
  formatCacheIdleMinutes,
  formatCacheRemaining,
  parseIdleMinutes
} from '../src/cache-hint-rules.js';
import { defaultWidgetConfig, normalizeWidgetConfig } from '../src/metrics.js';

test('缓存阶段：27 分钟前 idle，27–30 warn，30 以后 cold', () => {
  assert.equal(cacheStageFor(-1), 'idle');
  assert.equal(cacheStageFor(0), 'idle');
  assert.equal(cacheStageFor(CACHE_WARN_MS - 1), 'idle');
  assert.equal(cacheStageFor(CACHE_WARN_MS), 'warn');
  assert.equal(cacheStageFor(CACHE_COLD_MS - 1), 'warn');
  assert.equal(cacheStageFor(CACHE_COLD_MS), 'cold');
  assert.equal(cacheStageFor(CACHE_COLD_MS + 60_000), 'cold');
});

test('缓存倒计时：向上取整到秒，最后一秒显示 0:01', () => {
  assert.equal(formatCacheRemaining(3 * 60_000), '3:00');
  assert.equal(formatCacheRemaining(2 * 60_000 + 59_000), '2:59');
  assert.equal(formatCacheRemaining(1_000), '0:01');
  assert.equal(formatCacheRemaining(200), '0:01');
  assert.equal(formatCacheRemaining(0), '0:00');
});

test('闲置分钟：向下取整，不出现负数', () => {
  assert.equal(formatCacheIdleMinutes(CACHE_COLD_MS), 30);
  assert.equal(formatCacheIdleMinutes(CACHE_COLD_MS + 59_000), 30);
  assert.equal(formatCacheIdleMinutes(CACHE_COLD_MS + 60_000), 31);
  assert.equal(formatCacheIdleMinutes(-1), 0);
});

test('配置：缓存提醒默认关，显式 true 才开启，非法值回落默认', () => {
  assert.equal(defaultWidgetConfig().modules.pet.cacheHint, false);
  assert.equal(normalizeWidgetConfig({ modules: { pet: { cacheHint: true } } }).modules.pet.cacheHint, true);
  assert.equal(normalizeWidgetConfig({ modules: { pet: { cacheHint: false } } }).modules.pet.cacheHint, false);
  assert.equal(normalizeWidgetConfig({ modules: { pet: { cacheHint: 'on' } } }).modules.pet.cacheHint, false);
});

test('angryface / angryeye 不再作为点击彩蛋，提醒改用红色外观', () => {
  const pet = fs.readFileSync(new URL('../src/content/pet-panel.js', import.meta.url), 'utf8');
  const hint = fs.readFileSync(new URL('../src/content/cache-hint.js', import.meta.url), 'utf8');
  const click = pet.match(/const PET_CLICK_ANIMS = \[([\s\S]*?)\];/)?.[1] || '';
  const toggle = pet.match(/const PET_TOGGLE_ANIMS = \[([\s\S]*?)\];/)?.[1] || '';
  assert.doesNotMatch(click, /angryface|angryeye/);
  assert.doesNotMatch(toggle, /angryface|angryeye/);
  assert.match(hint, /ksb-cache-hot/);
  assert.doesNotMatch(hint, /ksb-cache-alert/);
});

test('侧栏相对时间：27m / 28 分钟 / 29分钟前 → 27/28/29；1h / 刚刚 → null', () => {
  assert.equal(parseIdleMinutes('27m'), 27);
  assert.equal(parseIdleMinutes('28 分钟'), 28);
  assert.equal(parseIdleMinutes('29分钟前'), 29);
  assert.equal(parseIdleMinutes('27 min'), 27);
  assert.equal(parseIdleMinutes('27m ago'), 27);
  assert.equal(parseIdleMinutes('27 minutes ago'), 27);
  assert.equal(parseIdleMinutes('1h'), null);
  assert.equal(parseIdleMinutes('刚刚'), null);
  assert.equal(parseIdleMinutes(''), null);
});
