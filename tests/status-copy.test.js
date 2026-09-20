// status-copy 状态归并测试：等级优先级与边界（文案表由 i18n 键保证，这里测等级）
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeStatus, STATUS_LONG, STATUS_SHORT } from '../src/panel-app/status-copy.js';

test('summarize：数据就绪即 ok（三种来源任一）', () => {
  assert.equal(summarizeStatus({ connected: true }), 'ok');
  assert.equal(summarizeStatus({ usageDailyOk: true }), 'ok');
  assert.equal(summarizeStatus({ hasAccum: true }), 'ok');
});

test('summarize：渲染异常与文件加载失败优先级最高', () => {
  assert.equal(summarizeStatus({ dispatchError: 'x', connected: true }), 'error');
  assert.equal(summarizeStatus({ fileState: '加载失败', connected: true }), 'error');
});

test('summarize：断开按持续时间分 connecting / failing（30s 边界）', () => {
  assert.equal(summarizeStatus({ kapKnown: false }), 'connecting');
  assert.equal(summarizeStatus({ wsState: 'closed(r3)' }), 'connecting');
  assert.equal(summarizeStatus({ wsState: '等kap源' }), 'connecting');
  assert.equal(summarizeStatus({ kapKnown: false, connectingMs: 29_999 }), 'connecting');
  assert.equal(summarizeStatus({ kapKnown: false, connectingMs: 30_000 }), 'failing');
  // 断开优先于数据就绪：句子挂在隐藏锁上不可见，但窄位短词等级准确
  assert.equal(summarizeStatus({ connected: true, wsState: 'closed(r1)' }), 'connecting');
});

test('summarize：管道健康但无历史 → fresh；启动初期 → loading', () => {
  assert.equal(summarizeStatus({ fileState: '无历史' }), 'fresh');
  assert.equal(summarizeStatus({}), 'loading');
  assert.equal(summarizeStatus({ fileState: '载入中' }), 'loading');
  assert.equal(summarizeStatus({ fileState: '已载入', usageDailyOk: false }), 'loading');
});

test('summarize：open 状态的 WS 与已知 kap 不判断开', () => {
  assert.equal(summarizeStatus({ wsState: 'open', kapKnown: true }), 'loading');
  assert.equal(summarizeStatus({ wsState: 'connecting', kapKnown: true }), 'loading');
});

test('文案表：每个等级都有长短两版且互相区分', () => {
  const levels = ['loading', 'fresh', 'connecting', 'failing', 'error'];
  for (const level of levels) {
    assert.ok(STATUS_LONG[level], `${level} 应有长文案`);
    assert.ok(STATUS_SHORT[level], `${level} 应有短文案`);
    assert.ok(STATUS_SHORT[level].length <= 4, `${level} 短文案应足够短（窄位显示）`);
  }
  assert.equal(STATUS_SHORT.loading, STATUS_SHORT.fresh, 'loading/fresh 共用「统计中…」');
});
