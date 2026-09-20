// Panel-app smoke 测试：用 jsdom 把构建产物 dist/panel-app.js 跑起来，
// 验证「独立面板页挂载出与侧栏一致的 #ksb-widget、桥接消息驱动渲染」。
// 数据入口是 window.__vibepal.push（Swift 侧协议），不经过 chrome.*。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { usageDayKey } from '../src/metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const PAGE_HTML = '<!DOCTYPE html><html><head></head><body></body></html>';

function injectScript(window, file) {
  const script = window.document.createElement('script');
  script.textContent = fs.readFileSync(path.join(ROOT, file), 'utf8');
  window.document.body.appendChild(script);
}

function tick(window, ms = 0) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function createPage() {
  const dom = new JSDOM(PAGE_HTML, {
    url: 'http://localhost:3000/panel/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true
  });
  const { window } = dom;
  // render.js 模块顶层构造 ResizeObserver（jsdom 无此 API）
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  return { dom, window };
}

test('panel-app：挂载出与侧栏一致的 #ksb-widget，默认全部模块可见', async () => {
  const { dom, window } = createPage();
  try {
    const ready = new Promise((resolve) => window.addEventListener('vibepal:panel-ready', resolve));
    injectScript(window, 'dist/panel-app.js');
    await ready;
    await tick(window);

    const widget = window.document.getElementById('ksb-widget');
    assert.ok(widget, '面板应被挂载');
    assert.ok(widget.closest('#ksb-panel-host'), '面板应挂在宿主容器内');
    // 全部模块（标题行/输入/缓存/输出/速度/上轮耗时/消耗量/子代理/外部账户 + Mini 区宠物与两条额度）
    for (const id of ['header', 'input', 'cache', 'output', 'speed', 'duration', 'usageChart', 'agents', 'external', 'pet', 'quota5h', 'quotaWeek']) {
      assert.ok(
        widget.querySelector(`.ksb-module[data-module="${id}"]`),
        `模块 ${id} 应渲染`
      );
    }
    assert.ok(window.document.getElementById('ksb-pet-canvas'), '宠物 canvas 应存在');
    assert.ok(window.document.getElementById('ksb-cli-lock'), '消耗量模块应带 CLI 锁');
  } finally {
    window.close();
  }
});

test('panel-app：桥接消息驱动额度 / 统计 / 会话事件渲染', async () => {
  const { dom, window } = createPage();
  try {
    const ready = new Promise((resolve) => window.addEventListener('vibepal:panel-ready', resolve));
    injectScript(window, 'dist/panel-app.js');
    await ready;
    await tick(window);
    // 等初始 idle 状态的最短显示时长（1.5s）过去，后续状态切换才不被节流
    await tick(window, 1600);

    const push = (msg) => window.__vibepal.push(msg);

    push({ v: 1, type: 'quota', quota: {
      limit5h: { usedRatio: 0.073, resetAt: new Date(Date.now() + 2.5 * 3600e3).toISOString() },
      limit7d: { usedRatio: 0.392, resetAt: new Date(Date.now() + 4 * 86400e3).toISOString() }
    }});
    assert.equal(
      window.document.getElementById('ksb-5h-pct').textContent,
      '7%',
      '5h 额度应按 usedRatio×100 渲染'
    );
    assert.equal(
      window.document.getElementById('ksb-week-pct').textContent,
      '39%',
      '本周额度应渲染'
    );
    assert.ok(
      window.document.querySelector('#ksb-5h-reset .ksb-reset-full').textContent.length > 0,
      '5h 重置倒计时应渲染'
    );

    const todayKey = usageDayKey(new Date());
    push({ v: 1, type: 'usageDaily',
      daily: { [todayKey]: { input: 42000, output: 3800, cacheRead: 21800, sub: { input: 8200, output: 900, cacheRead: 2500 } } },
      hourly: {},
      secondaryModel: 'kimi-k2-thinking-turbo'
    });
    assert.equal(
      window.document.getElementById('ksb-cli-lock').hidden,
      true,
      'CLI 统计推送后锁提示应隐藏'
    );
    assert.equal(
      window.document.getElementById('ksb-chart-total').textContent,
      '45.8k',
      '消耗量应显示汇总数字'
    );

    push({ v: 1, type: 'status', status: 'working' });
    assert.equal(
      window.document.getElementById('ksb-agent-status').textContent,
      '思考中',
      'working 状态应点亮状态灯'
    );

    push({ v: 1, type: 'event', sessionId: 'test-session', event: { type: 'turn.started', payload: {} } });
    push({ v: 1, type: 'event', event: {
      type: 'turn.step.completed',
      payload: { usage: { inputOther: 12000, inputCacheRead: 32000, inputCacheCreation: 0, output: 800 }, llmStreamDurationMs: 4000 }
    }});
    assert.equal(
      window.document.getElementById('ksb-input-tokens').textContent,
      '44k',
      'step 完成应累计输入 tokens'
    );
    assert.equal(
      window.document.getElementById('ksb-output-tokens').textContent,
      '800',
      'step 完成应累计输出 tokens'
    );

    push({ v: 1, type: 'event', event: { type: 'subagent.spawned', payload: { subagentId: 'agent-1' } } });
    push({ v: 1, type: 'event', event: {
      agent_id: 'agent-1',
      type: 'turn.step.completed',
      payload: { usage: { inputOther: 8000, inputCacheRead: 20000, inputCacheCreation: 0, output: 600 }, llmStreamDurationMs: 3000 }
    }});
    assert.ok(
      window.document.querySelector('#ksb-agents-list .ksb-agent-badge.sub'),
      '子代理应出现在代理模块'
    );

    push({ v: 1, type: 'event', event: { type: 'turn.ended', payload: { durationMs: 12800 } } });
    // 状态最短显示 1.5s：等节流放行后再断言回到空闲
    await tick(window, 1600);
    assert.equal(
      window.document.getElementById('ksb-agent-status').textContent,
      '空闲',
      '轮次结束后应回到空闲'
    );
    assert.equal(
      window.document.getElementById('ksb-duration-value').textContent,
      '12.8s',
      '上轮耗时应记录'
    );
  } finally {
    window.close();
  }
});
