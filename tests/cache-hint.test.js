import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';

import {
  CACHE_COLD_MS,
  CACHE_WARN_MS,
  cacheStageFor,
  formatCacheIdleMinutes,
  formatCacheRemaining
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

test('配置：缓存提醒默认开，显式 false 保留，非法值回落默认', () => {
  assert.equal(defaultWidgetConfig().modules.pet.cacheHint, true);
  assert.equal(normalizeWidgetConfig({ modules: { pet: { cacheHint: false } } }).modules.pet.cacheHint, false);
  assert.equal(normalizeWidgetConfig({ modules: { pet: { cacheHint: 'off' } } }).modules.pet.cacheHint, true);
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
