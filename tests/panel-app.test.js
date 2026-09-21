// Panel-app smoke 测试：用 jsdom 把构建产物 dist/panel-app.js 跑起来，
// 验证「独立面板页挂载出与侧栏一致的 #ksb-widget、push 总线消息驱动渲染」。
// 数据入口是 window.__kcm.push（direct.js / loader.js 的同款协议），不经过 chrome.*。
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

test('panel-app：挂载出与侧栏一致的 #ksb-widget，默认布局分区正确', async () => {
  const { dom, window } = createPage();
  try {
    const ready = new Promise((resolve) => window.addEventListener('kcm:panel-ready', resolve));
    injectScript(window, 'dist/panel-app.js');
    await ready;
    await tick(window);

    const widget = window.document.getElementById('ksb-widget');
    assert.ok(widget, '面板应被挂载');
    assert.ok(widget.closest('#ksb-panel-host'), '面板应挂在宿主容器内');
    // 默认布局：Mini 区宠物（整行）+两条额度；完整区外部账户（整行）+四个数值模块；
    // 标题行/上轮耗时/代理/消耗图表默认收进隐藏区（不渲染）
    for (const id of ['pet', 'quota5h', 'quotaWeek', 'external', 'output', 'cache', 'input', 'speed']) {
      assert.ok(
        widget.querySelector(`.ksb-module[data-module="${id}"]`),
        `模块 ${id} 应渲染`
      );
    }
    for (const id of ['header', 'duration', 'agents', 'usageChart']) {
      assert.ok(
        !widget.querySelector(`.ksb-module[data-module="${id}"]`),
        `模块 ${id} 默认应在隐藏区`
      );
    }
    assert.ok(window.document.getElementById('ksb-pet-canvas'), '宠物 canvas 应存在');
  } finally {
    window.close();
  }
});

test('panel-app：桥接消息驱动额度 / 统计 / 会话事件渲染', async () => {
  const { dom, window } = createPage();
  try {
    // 本用例要断言子代理/外部账户模块：预置一份全可见配置（默认布局已把两者收进隐藏区）
    window.localStorage.setItem('kimi-statusbar.config', JSON.stringify({
      version: 3,
      modules: {
        header: { show: 'full', span: 2, showBalance: true, balanceLink: 'subscription' },
        input: { show: 'full', span: 1 }, cache: { show: 'full', span: 1 },
        output: { show: 'full', span: 1 }, speed: { show: 'full', span: 1 },
        duration: { show: 'full', span: 1 },
        quota5h: { show: 'mini', span: 1, pace: true, resetFormat: 'countdown' },
        quotaWeek: { show: 'mini', span: 1, pace: true, resetFormat: 'countdown' },
        usageChart: { show: 'full', span: 2, chartRange: 'week' },
        pet: { show: 'mini', span: 2, stat: 'daily', sidebarTidy: true, ballLink: 'none' },
        agents: { show: 'full', span: 2, hiddenAgents: [] },
        external: { show: 'full', span: 1, hiddenAccounts: [] }
      },
      orderFull: ['header', 'input', 'cache', 'output', 'speed', 'duration', 'usageChart', 'agents', 'external'],
      orderMini: ['pet', 'quota5h', 'quotaWeek'],
      orderHidden: []
    }));
    const ready = new Promise((resolve) => window.addEventListener('kcm:panel-ready', resolve));
    injectScript(window, 'dist/panel-app.js');
    await ready;
    await tick(window);
    // 等初始 idle 状态的最短显示时长（1.5s）过去，后续状态切换才不被节流
    await tick(window, 1600);

    const push = (msg) => window.__kcm.push(msg);

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

test('panel-app：真实形状长期统计解锁图表（多天 + sub 子桶 + 历史久远日期）', async () => {
  const { window } = createPage();
  try {
    // 消耗图表默认在隐藏区：本用例断言锁与图表，预置全可见配置
    window.localStorage.setItem('kimi-statusbar.config', JSON.stringify({
      version: 3,
      modules: {
        header: { show: 'full', span: 2, showBalance: true, balanceLink: 'subscription' },
        input: { show: 'full', span: 1 }, cache: { show: 'full', span: 1 },
        output: { show: 'full', span: 1 }, speed: { show: 'full', span: 1 },
        duration: { show: 'full', span: 1 },
        quota5h: { show: 'mini', span: 1, pace: true, resetFormat: 'countdown' },
        quotaWeek: { show: 'mini', span: 1, pace: true, resetFormat: 'countdown' },
        usageChart: { show: 'full', span: 2, chartRange: 'week' },
        pet: { show: 'mini', span: 2, stat: 'daily', sidebarTidy: true, ballLink: 'none' },
        agents: { show: 'full', span: 2, hiddenAgents: [] },
        external: { show: 'full', span: 1, hiddenAccounts: [] }
      },
      orderFull: ['header', 'input', 'cache', 'output', 'speed', 'duration', 'usageChart', 'agents', 'external'],
      orderMini: ['pet', 'quota5h', 'quotaWeek'],
      orderHidden: []
    }));
    const ready = new Promise((resolve) => window.addEventListener('kcm:panel-ready', resolve));
    injectScript(window, 'dist/panel-app.js');
    await ready;
    await tick(window);

    // 数据未到：独立面板锁位显示状态句（人话）而非「连接本地 CLI」（无目录授权动作）
    const lock = window.document.getElementById('ksb-cli-lock');
    assert.ok(lock, '锁元素应存在');
    assert.equal(lock.disabled, true, '独立面板的锁不可点击');
    assert.ok(lock.textContent.includes('正在加载数据统计'), '锁文案应为初始状态句');
    assert.ok(window.document.getElementById('kcm-data-status'), '诊断状态位应存在');
    assert.ok(window.document.getElementById('ksb-status-sentence'), '状态句元素应存在');

    const push = (msg) => window.__kcm.push(msg);
    const todayKey = usageDayKey(new Date());
    const old = new Date();
    old.setDate(old.getDate() - 40);
    push({ v: 1, type: 'usageDaily',
      daily: {
        [usageDayKey(old)]: { input: 9000000, output: 900000, cacheRead: 8000000 },
        [todayKey]: {
          input: 420000, output: 38000, cacheRead: 218000,
          sub: { input: 82000, output: 9000, cacheRead: 25000 }
        }
      },
      hourly: { [`${todayKey}T09`]: { input: 120000, output: 9000, cacheRead: 60000, sub: { input: 0, output: 0, cacheRead: 0 } } },
      secondaryModel: 'StepFun Step Plan/step-5-preview'
    });
    assert.equal(lock.hidden, true, '推送后锁应隐藏');
    // week 口径只含最近 7 天：40 天前的大数不进汇总
    assert.equal(
      window.document.getElementById('ksb-chart-total').textContent,
      '458k',
      '消耗量应只汇总近 7 天'
    );
  } finally {
    window.close();
  }
});

test('panel-app：单条异常消息不锁死桥接（后续消息照常渲染）', async () => {
  const { window } = createPage();
  try {
    const ready = new Promise((resolve) => window.addEventListener('kcm:panel-ready', resolve));
    injectScript(window, 'dist/panel-app.js');
    await ready;
    await tick(window, 1600);

    // 属性读取即抛的消息（模拟未知数据形状）：不应把异常抛给 push 调用方
    const evil = { v: 1, type: 'quota', get quota() { throw new Error('boom'); } };
    assert.doesNotThrow(() => window.__kcm.push(evil), '异常消息应被吞掉并记录');
    assert.ok(
      String(window.__kcmDebug?.dispatchError || '').includes('quota'),
      '异常应记入诊断标记'
    );

    window.__kcm.push({ v: 1, type: 'quota', quota: {
      limit5h: { usedRatio: 0.5, resetAt: new Date(Date.now() + 3600e3).toISOString() }
    }});
    assert.equal(
      window.document.getElementById('ksb-5h-pct').textContent,
      '50%',
      '异常之后的正常消息应照常渲染'
    );
  } finally {
    window.close();
  }
});


test('panel-app：会话路由下直连模式启动不抛错（TDZ 回归）', async () => {
  // 曾因 pollFocus 在 ws 声明前调用 wsSubscribe 同步抛错，
  // 炸掉 startDirectMode 后半段与 panel-ready 事件派发；
  // 该 bug 只在 URL 含 /sessions/<id> 时触发（现有测试的 URL 恰好绕开）
  const dom = new JSDOM(PAGE_HTML, {
    url: 'http://localhost:3000/sessions/session_tdz-regress',
    runScripts: 'dangerously',
    pretendToBeVisual: true
  });
  const { window } = dom;
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  try {
    const ready = new Promise((resolve) => window.addEventListener('kcm:panel-ready', resolve));
    injectScript(window, 'dist/panel-app.js');
    await ready;
    await tick(window, 100);
    assert.ok(window.__kcmDebug, '直连模式应写入调试状态');
    assert.ok(
      window.__kcmDebug.wsState,
      'WS 状态应被记录而非在启动时抛错'
    );
  } finally {
    window.close();
  }
});
