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
import { panel, subagentModelGroups, resetSessionAgents, seedSessionAgent } from '../src/content/panel-state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const PAGE_HTML = '<!DOCTYPE html><html><head></head><body></body></html>';

// 全模块可见的布局配置：默认布局把子代理/耗时/图表收在隐藏区，
// 需要断言这些模块的用例先把它写进 localStorage
const VISIBLE_CONFIG = {
  version: 3,
  modules: {
    header: { show: 'full', span: 2, stat: 'balance', balanceLink: 'subscription' },
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
};

function setVisibleConfig(window) {
  window.localStorage.setItem('kimi-statusbar.config', JSON.stringify(VISIBLE_CONFIG));
}

// 同上，但覆盖两个模块各自的右侧数据口径（stat）——验证它们互不影响
function setConfigWithStats(window, headerStat, petStat) {
  const config = JSON.parse(JSON.stringify(VISIBLE_CONFIG));
  config.modules.header.stat = headerStat;
  config.modules.pet.stat = petStat;
  window.localStorage.setItem('kimi-statusbar.config', JSON.stringify(config));
}

/** kap 现在返回的真实形状：字段齐全但全为零 */
function zeroSnapshot(busy = false) {
  return {
    busy,
    usage: {
      input_tokens: 0, output_tokens: 0,
      cache_read_tokens: 0, cache_creation_tokens: 0
    }
  };
}

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
    setVisibleConfig(window);
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
    setVisibleConfig(window);
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


test('panel-app：切走再切回，同页缓存把数值与耗时接回来（不等服务器）', async () => {
  const { window } = createPage();
  try {
    setVisibleConfig(window);
    const ready = new Promise((resolve) => window.addEventListener('kcm:panel-ready', resolve));
    injectScript(window, 'dist/panel-app.js');
    await ready;
    await tick(window);
    const push = (msg) => window.__kcm.push(msg);
    const text = (id) => window.document.getElementById(id).textContent;

    // 会话 A 干了活：一个 step（12k 非缓存 + 32k 缓存读）+ 一轮结束（12.8s）
    push({ v: 1, type: 'event', sessionId: 'session_a', event: { type: 'turn.started', payload: {} } });
    push({ v: 1, type: 'event', event: {
      type: 'turn.step.completed',
      payload: { usage: { inputOther: 12000, inputCacheRead: 32000, inputCacheCreation: 0, output: 800 }, llmStreamDurationMs: 4000 }
    }});
    push({ v: 1, type: 'event', event: { type: 'turn.ended', payload: { durationMs: 12800 } } });
    assert.equal(text('ksb-input-tokens'), '44k');
    assert.equal(text('ksb-duration-value'), '12.8s');

    // 切到会话 B：B 没在客户端里打开过，快照又是 kap 现在的全零形状 → 归零
    push({ v: 1, type: 'session', sid: 'session_b', snapshot: zeroSnapshot() });
    assert.equal(text('ksb-input-tokens'), '0', '切到空会话应清零');
    assert.equal(text('ksb-duration-value'), '--');

    // 切回会话 A：数值、折线样本、上轮耗时立刻回来——全零快照不许覆盖缓存
    push({ v: 1, type: 'session', sid: 'session_a', snapshot: zeroSnapshot() });
    assert.equal(text('ksb-input-tokens'), '44k', '切回应由同页缓存恢复');
    assert.equal(text('ksb-duration-value'), '12.8s', '上轮耗时应一起回来');
  } finally {
    window.close();
  }
});

test('panel-app：全零快照不当底数，非零快照才写进面板', async () => {
  const { window } = createPage();
  try {
    setVisibleConfig(window);
    const ready = new Promise((resolve) => window.addEventListener('kcm:panel-ready', resolve));
    injectScript(window, 'dist/panel-app.js');
    await ready;
    await tick(window);
    const push = (msg) => window.__kcm.push(msg);
    const inputText = () => window.document.getElementById('ksb-input-tokens').textContent;

    // 全零快照（kap 现状）：不写入，也不报错
    push({ v: 1, type: 'session', sid: 'session_zero', snapshot: zeroSnapshot() });
    assert.equal(inputText(), '0');

    // 非零快照：作为底数写入（input 显示含缓存的全部输入）
    push({ v: 1, type: 'session', sid: 'session_seed', snapshot: {
      busy: false,
      usage: { input_tokens: 1000, output_tokens: 100, cache_read_tokens: 200, cache_creation_tokens: 0 }
    }});
    assert.equal(inputText(), '1.2k', '快照非零时应作为底数');
    assert.equal(window.document.getElementById('ksb-output-tokens').textContent, '100');
  } finally {
    window.close();
  }
});

test('panel-app：离开会话页清空焦点，回到同一会话重新取快照', async () => {
  // focusedSid 不清零时，从主页回到同一会话会被 sid === focusedSid 跳过，
  // 诊断行也会一直停在离开前的会话上
  const dom = new JSDOM(PAGE_HTML, {
    url: 'http://localhost:3000/sessions/session_focus',
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
    assert.equal(window.__kcmDebug.focusedSid, 'session_focus', '首屏应锁定会话');

    window.history.pushState({}, '', '/');
    await tick(window, 1_200);
    assert.equal(window.__kcmDebug.focusedSid, '', '离开会话页应清空焦点');

    window.history.pushState({}, '', '/sessions/session_focus');
    await tick(window, 1_200);
    assert.equal(window.__kcmDebug.focusedSid, 'session_focus', '回到同一会话应重新锁定');
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

test('panel-app：重启后的历史重放不把空闲会话抬成「思考中」（活跃度只看实时事件）', async () => {
  // 回归：客户端重启 → 页面重载 → client_hello 游标 0 → 服务端重放整段历史。
  // 重放事件不得触发活跃度模型，否则空闲会话被抬成「思考中」并从 0 计时
  const dom = new JSDOM(PAGE_HTML, {
    url: 'http://localhost:3000/sessions/session_replay-idle',
    runScripts: 'dangerously',
    pretendToBeVisual: true
  });
  const { window } = dom;
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  // 状态灯在标题行模块里，默认收在隐藏区：预置全可见配置才能断言
  setVisibleConfig(window);
  // kap 源：直连模式 WS 必须等源解析，测试里经 SPA 同款 sessionStorage 提供
  window.sessionStorage.setItem('kimi-desktop-server-origin', 'http://127.0.0.1:56189');
  // 假 WebSocket：拦截直连模式的事件流，由用例扮演服务端
  const sockets = [];
  window.WebSocket = class {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.sent = [];
      sockets.push(this);
    }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() {}
  };
  try {
    const ready = new Promise((resolve) => window.addEventListener('kcm:panel-ready', resolve));
    injectScript(window, 'dist/panel-app.js');
    await ready;
    await tick(window, 100);

    const ws = sockets[0];
    assert.ok(ws, '直连模式应在 kap 源已知时发起 WS 连接');
    ws.onopen();
    // 服务端握手 → 面板订阅当前会话（游标 0 = 换取整段历史重放）
    ws.onmessage({ data: JSON.stringify({ type: 'server_hello' }) });
    await tick(window, 50);
    const hello = ws.sent.find((f) => f.type === 'client_hello');
    assert.deepEqual(hello?.payload?.subscriptions, ['session_replay-idle']);

    // 应答之前重放整段历史：轮次开始 / 推理流 / 工具调用 / 步骤完成 / 轮次结束
    const replay = [
      { type: 'turn.started', seq: 1, session_id: 'session_replay-idle', payload: {} },
      { type: 'thinking.delta', seq: 2, session_id: 'session_replay-idle', payload: {} },
      { type: 'tool.call.started', seq: 3, session_id: 'session_replay-idle', payload: {} },
      { type: 'turn.step.completed', seq: 4, session_id: 'session_replay-idle', payload: { usage: { inputOther: 5000, output: 500, inputCacheRead: 0, inputCacheCreation: 0 } } },
      { type: 'turn.ended', seq: 5, session_id: 'session_replay-idle', payload: { durationMs: 8000 } }
    ];
    for (const m of replay) ws.onmessage({ data: JSON.stringify(m) });
    ws.onmessage({ data: JSON.stringify({ type: 'ack', payload: {} }) });
    // 状态灯有 1.5s 最短显示：等节流窗口过去再断言
    await tick(window, 1_700);
    assert.equal(
      window.document.getElementById('ksb-agent-status').textContent,
      '空闲',
      '历史重放不得把空闲会话抬成「思考中」'
    );

    // 应答之后的实时事件照常点亮（活跃度模型未被误伤）
    ws.onmessage({ data: JSON.stringify({ type: 'turn.started', seq: 6, session_id: 'session_replay-idle', payload: {} }) });
    await tick(window, 1_700);
    assert.equal(
      window.document.getElementById('ksb-agent-status').textContent,
      '思考中',
      '实时 turn.started 应点亮状态灯'
    );
  } finally {
    window.close();
  }
});

test('panel-app：余额跟随 kap 的 extraUsage 活数据，无钱包字段的额度消息不清空', async () => {
  const { window } = createPage();
  try {
    setVisibleConfig(window);
    const ready = new Promise((resolve) => window.addEventListener('kcm:panel-ready', resolve));
    injectScript(window, 'dist/panel-app.js');
    await ready;
    await tick(window);
    const push = (msg) => window.__kcm.push(msg);
    const balance = () => window.document.getElementById('ksb-header-stat-text').textContent;
    // kap 真实形状：extraUsage 单位是分；balanceCents 1358 → ¥13.58
    const kapQuota = (extraUsage) => ({
      v: 1, type: 'quota',
      quota: {
        limit5h: { usedRatio: 0.06, resetAt: '2026-10-18T09:45:42Z' },
        limit7d: { usedRatio: 0.47, resetAt: '2026-10-22T09:45:42Z' }
      },
      ...(extraUsage === undefined ? {} : { extraUsage })
    });

    // 活数据到达：余额按分→元显示
    push(kapQuota({ balanceCents: 1358, totalCents: 5000, currency: 'CNY' }));
    assert.equal(balance(), '¥13.58');

    // 曾经的 bug：只带 usages 的额度消息（每 60s 一条）把余额清成「余额 --」，
    // 再被 wallet.js 快照轮询短暂恢复——用户看到的就是闪烁/不管用。现在沿用旧值
    push(kapQuota());
    assert.equal(balance(), '¥13.58', '无钱包字段的额度消息不得清空余额');

    // wallet.js 快照（web API 形状）在活数据未到位前兜底；活数据已到位、
    // 快照时间戳更旧时被忽略（不会把活数据覆盖回陈旧快照）
    push({ v: 1, type: 'quota', quota: { wallet: { status: 'STATUS_ACTIVE', balance: { amountLeft: '99900000000' } } }, walletFetchedAt: '2026-10-14T23:13:00.000Z' });
    assert.equal(balance(), '¥13.58');

    // extraUsage 为 null（本机实测恒为 null）：语义是「kap 不提供」而非「账户没有
    // 钱包」——不能据此清空，沿用上次成功值（活数据路径下由 wallet.js 快照接管）
    push(kapQuota(null));
    assert.equal(balance(), '¥13.58', 'extraUsage 为 null 是「kap 不提供」，不是「没有钱包」');
  } finally {
    window.close();
  }
});

test('panel-app：活数据未到位时 wallet.js 快照兜底（web API 形状）', async () => {
  const { window } = createPage();
  try {
    setVisibleConfig(window);
    const ready = new Promise((resolve) => window.addEventListener('kcm:panel-ready', resolve));
    injectScript(window, 'dist/panel-app.js');
    await ready;
    await tick(window);
    const push = (msg) => window.__kcm.push(msg);
    const balance = () => window.document.getElementById('ksb-header-stat-text').textContent;

    // 首屏：kap 还没响应，loader 的 wallet.js 快照（安装时写入）先兜底
    push({
      v: 1, type: 'quota',
      quota: { wallet: { status: 'STATUS_ACTIVE', balance: { amountLeft: '9990000000' } } },
      walletFetchedAt: '2026-10-14T23:13:00.000Z'
    });
    assert.equal(balance(), '¥99.90');
    // 快照的数据时间进悬停提示（桌面端余额是快照制，不能让人以为是实时数）
    // （提示挂在药丸上：字段名 + 跳转说明 + 数据时间；药丸里只显示数额）
    const slot = window.document.getElementById('ksb-header-stat');
    const at = new Date('2026-10-14T23:13:00.000Z');
    const pad = (n) => String(n).padStart(2, '0');
    const local = `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
    assert.ok(slot.title.includes(local), `提示应含本地数据时间 ${local}，实际：${slot.title}`);

    // 活数据随后到达：以活数据为准（kap extraUse 单位分）
    push({ v: 1, type: 'quota', quota: { limit5h: { usedRatio: 0.06 } }, extraUsage: { balanceCents: 1358, currency: 'CNY' } });
    assert.equal(balance(), '¥13.58');

    // 用户跑过技能「刷新余额」：fetchedAt 比上次活数据新，快照重新生效
    push({
      v: 1, type: 'quota',
      quota: { wallet: { status: 'STATUS_ACTIVE', balance: { amountLeft: '8880000000' } } },
      walletFetchedAt: new Date(Date.now() + 60_000).toISOString()
    });
    assert.equal(balance(), '¥88.80');
  } finally {
    window.close();
  }
});

test('panel-app：长期统计到达后标题行数据位跟着刷（曾经停在首帧「统计中」）', async () => {
  // 回归：数据到达路径只调了 renderPetStats，标题行停在首帧的状态文案，
  // 要进编辑模式（重建结构）才「碰巧」正确
  const { window } = createPage();
  try {
    setConfigWithStats(window, 'daily', 'balance');
    const ready = new Promise((resolve) => window.addEventListener('kcm:panel-ready', resolve));
    injectScript(window, 'dist/panel-app.js');
    await ready;
    await tick(window);
    const doc = window.document;
    // 首帧还没有今天的数：显示占位（不是数字）
    assert.notEqual(doc.getElementById('ksb-header-stat-text').textContent, '');
    // 长期统计到达 → 标题行与宠物都刷成数字
    const todayKey = usageDayKey(new Date());
    window.__kcm.push({
      v: 1,
      type: 'usageDaily',
      daily: { [todayKey]: { input: 420000, output: 38000, cacheRead: 218000 } },
      hourly: {}
    });
    await tick(window);
    // 标题行（今日消耗口径）跟着刷成数字；宠物是余额口径，没有钱包时是占位
    assert.match(doc.getElementById('ksb-header-stat-text').textContent, /\d/);
    assert.equal(doc.getElementById('ksb-pet-total-text').textContent, '余额 --');
  } finally {
    window.close();
  }
});

test('panel-app：标题行右侧数据位与宠物共用口径，余额口径带可点刷新', async () => {
  // 余额口径：标签 + 数字 + 无边框刷新图标；点图标走 refreshBalance 钩子
  const first = createPage();
  try {
    setVisibleConfig(first.window);
    let refreshed = 0;
    first.window.__kcmRefreshWallet = () => { refreshed += 1; };
    const ready = new Promise((resolve) => first.window.addEventListener('kcm:panel-ready', resolve));
    injectScript(first.window, 'dist/panel-app.js');
    await ready;
    await tick(first.window);
    const doc = first.window.document;
    // 药丸里是「字段名 + 数额」：字段名用面板里的简称（窄了由 CSS 隐藏），数额在悬停提示里也有
    assert.equal(doc.getElementById('ksb-header-stat-label').textContent, '余额');
    assert.equal(doc.getElementById('ksb-header-stat-text').textContent, '余额 --');
    assert.match(doc.getElementById('ksb-header-stat').title, /加油包余额/);
    const refreshBtn = doc.getElementById('ksb-header-stat-refresh');
    assert.ok(refreshBtn, '余额口径应挂刷新图标');
    assert.equal(refreshBtn.hidden, false);
    // 刷新图标只触发取数，不做手势校验，jsdom 的合成点击可以直接驱动
    refreshBtn.dispatchEvent(new first.window.MouseEvent('click', { bubbles: true }));
    assert.equal(refreshed, 1, '点图标应触发一次手动刷新');
    // 宠物模块选的是「今日消耗」，不挂刷新图标（非余额口径本来就会自动更新）
    assert.equal(doc.getElementById('ksb-pet-stat-refresh').hidden, true);
  } finally {
    first.window.close();
  }

  // 两个模块各选各的：标题行「缓存命中」时宠物仍是「余额」，互不联动
  const second = createPage();
  try {
    setConfigWithStats(second.window, 'cache', 'balance');
    const ready = new Promise((resolve) => second.window.addEventListener('kcm:panel-ready', resolve));
    injectScript(second.window, 'dist/panel-app.js');
    await ready;
    await tick(second.window);
    const doc = second.window.document;
    // 面板里显示简称「余额」，完整名「加油包余额」只在菜单/悬停里
    assert.equal(doc.getElementById('ksb-pet-label').textContent, '余额');
    assert.match(doc.getElementById('ksb-header-stat').title, /缓存命中/);
    // 非余额口径不挂刷新图标；宠物是余额口径 → 只在宠物那边出现，且贴在字段名旁
    assert.equal(doc.getElementById('ksb-header-stat-refresh').hidden, true);
    const petRefresh = doc.getElementById('ksb-pet-stat-refresh');
    assert.equal(petRefresh.hidden, false);
    assert.equal(petRefresh.parentElement.className, 'ksb-pet-label-row');
    // 图标是内联 SVG（字形在不同字号下会飘）
    assert.ok(petRefresh.querySelector('svg.ksb-stat-refresh-icon'));
    // 余额口径的药丸可点（dataLink 配了目标就整颗可点，与宠物小球同一套语义）
    assert.equal(doc.getElementById('ksb-header-stat').dataset.link, '1');
  } finally {
    second.window.close();
  }
});

test('panel-app：切到没打开过的会话，用本地汇总做底（代理 × 模型分行）', async () => {
  const { window } = createPage();
  try {
    setVisibleConfig(window);
    const ready = new Promise((resolve) => window.addEventListener('kcm:panel-ready', resolve));
    injectScript(window, 'dist/panel-app.js');
    await ready;
    await tick(window);
    const push = (msg) => window.__kcm.push(msg);
    const text = (id) => window.document.getElementById(id).textContent;
    const agentRows = () => [...window.document.querySelectorAll('#ksb-agents-list .ksb-agent-row')]
      .map((row) => [...row.children].map((cell) => cell.textContent.trim()));

    // 装补丁时预填的 usage-daily.js：daily/hourly 为空，只有按会话汇总
    push({
      v: 1, type: 'usageDaily', daily: {}, hourly: {}, secondaryModel: 'step-5-preview',
      sessions: {
        session_c: {
          input: 30000, output: 500, cacheRead: 20000,
          agents: {
            main: {
              models: { 'kimi-code/k3': { input: 21000, output: 300, cacheRead: 17000, records: 9 } },
              firstAt: 1, lastAt: 2
            },
            'agent-1': {
              models: { 'kimi-code/kimi-for-coding': { input: 9000, output: 200, cacheRead: 3000, records: 4 } },
              firstAt: 1, lastAt: 2
            }
          }
        }
      }
    });

    // 切到该会话：快照是 kap 现在的全零形状 → 落到本地汇总做底（原先只会全零）
    push({ v: 1, type: 'session', sid: 'session_c', snapshot: zeroSnapshot() });
    assert.equal(text('ksb-input-tokens'), '30k', '没用过的会话应由本地汇总做底');
    assert.equal(text('ksb-output-tokens'), '500');

    // 代理明细：主代理一行一个模型；子代理按模型合并（单实例无计数后缀），模型名前缀已剥
    assert.deepEqual(agentRows(), [
      ['主', 'k3', '21k', '300', '80.9%'],
      // 模型名去掉 kimi-code/ 与 kimi- 前缀（窄面板里保留可辨识部分）
      ['子', 'for-coding', '9k', '200', '33.3%']
    ]);
  } finally {
    window.close();
  }
});

test('panel-app：同模型的多个子代理合并为一行（名称标共 N 个），主代理仍按模型分行', async () => {
  const { window } = createPage();
  try {
    setVisibleConfig(window);
    const ready = new Promise((resolve) => window.addEventListener('kcm:panel-ready', resolve));
    injectScript(window, 'dist/panel-app.js');
    await ready;
    await tick(window);
    const push = (msg) => window.__kcm.push(msg);
    const agentRows = () => [...window.document.querySelectorAll('#ksb-agents-list .ksb-agent-row')]
      .map((row) => [...row.children].map((cell) => cell.textContent.trim()));

    push({
      v: 1, type: 'usageDaily', daily: {}, hourly: {}, sessions: {
        session_d: {
          input: 6000, output: 60, cacheRead: 0,
          agents: {
            // 主代理中途换过模型：两个模型两行（主代理不参与合并）
            main: {
              models: {
                'kimi-code/k3-256k': { input: 2000, output: 20, cacheRead: 0, records: 2 },
                'kimi-code/k3': { input: 1000, output: 10, cacheRead: 0, records: 1 }
              },
              firstAt: 1, lastAt: 3
            },
            // 同一个模型的三个子代理：合并成一行，名称标（共 3 个），用量求和
            'agent-1': { models: { 'kimi-code/small': { input: 1000, output: 10, cacheRead: 0, records: 1 } }, firstAt: 1, lastAt: 1 },
            'agent-2': { models: { 'kimi-code/small': { input: 1000, output: 10, cacheRead: 0, records: 1 } }, firstAt: 2, lastAt: 2 },
            'agent-3': { models: { 'kimi-code/small': { input: 1000, output: 10, cacheRead: 0, records: 1 } }, firstAt: 3, lastAt: 3 },
            // 另一个模型的单实例：单独一行，无计数后缀
            'agent-4': { models: { 'kimi-code/other': { input: 1000, output: 10, cacheRead: 0, records: 1 } }, firstAt: 4, lastAt: 4 }
          }
        }
      }
    });

    push({ v: 1, type: 'session', sid: 'session_d', snapshot: zeroSnapshot() });
    // 主代理两行（各自一个模型）；子代理两行：small 三实例合并（3k/30）、other 单实例
    assert.deepEqual(agentRows(), [
      ['主', 'k3-256k', '2k', '20', '0.0%'],
      ['主', 'k3', '1k', '10', '0.0%'],
      ['子', 'small×3', '3k', '30', '0.0%'],
      ['子', 'other', '1k', '10', '0.0%']
    ]);
    // 合并行的悬停列成员代理（上限 8 个）
    const mergedTitle = window.document.querySelector('#ksb-agents-list .ksb-agent-row:nth-child(3)').title;
    assert.match(mergedTitle, /子代理 1 · small/);
    assert.match(mergedTitle, /子代理 3 · small/);
    assert.doesNotMatch(mergedTitle, /子代理 4/);
  } finally {
    window.close();
  }
});

test('子代理按模型合并：同模型多实例一组（用量求和、成员按出现序），隐藏的代理整组扣除', () => {
  resetSessionAgents();
  seedSessionAgent('main', { 'kimi-code/k3': { input: 1000, output: 10, cacheRead: 0, records: 1 } });
  seedSessionAgent('agent-1', { 'kimi-code/small': { input: 1000, output: 10, cacheRead: 0, records: 1 } });
  seedSessionAgent('agent-2', { 'kimi-code/small': { input: 2000, output: 20, cacheRead: 0, records: 2 } });
  seedSessionAgent('agent-3', { 'kimi-code/other': { input: 500, output: 5, cacheRead: 0, records: 1 } });

  const groups = subagentModelGroups([]);
  // main 不进组；两组子代理（分组键是显示名），用量大的在前
  assert.deepEqual(groups.map((g) => g.label), ['small', 'other']);
  const small = groups[0];
  assert.deepEqual(small.agents, ['agent-1', 'agent-2']);
  // 合并行用量 = 成员用量之和（输入含缓存读口径）
  assert.equal(small.totals.inputTokens + small.totals.cacheReadTokens, 3000);
  assert.equal(small.totals.outputTokens, 30);

  // 隐藏 agent-1：该组只剩 agent-2，用量与计数同步扣除（不是把整组藏掉）
  const filtered = subagentModelGroups(['agent-1']);
  assert.deepEqual(filtered[0].agents, ['agent-2']);
  assert.equal(filtered[0].totals.inputTokens + filtered[0].totals.cacheReadTokens, 2000);
  assert.equal(filtered[0].totals.outputTokens, 20);

  // 整组都被隐藏时该组消失（other 组只剩 agent-3，隐藏后不出现）
  assert.deepEqual(subagentModelGroups(['agent-3']).map((g) => g.label), ['small']);

  resetSessionAgents();
});

test('子代理按模型合并：分组键是显示名——剥前缀后同形的模型不分成两行', () => {
  resetSessionAgents();
  seedSessionAgent('main', { 'kimi-code/k3': { input: 1000, output: 10, cacheRead: 0, records: 1 } });
  // 同一模型的两种写法（实时事件带全名、扫描汇总带短名）：显示名都是 k2
  seedSessionAgent('agent-1', { 'kimi-for-coding': { input: 1000, output: 10, cacheRead: 0, records: 1 } });
  seedSessionAgent('agent-2', { 'kimi-code/kimi-for-coding': { input: 2000, output: 20, cacheRead: 0, records: 2 } });
  // __secondary__ 占位符：有次级模型真名时归到真名组
  panel.secondaryModelName = 'kimi-code/step-5';
  seedSessionAgent('agent-3', { __secondary__: { input: 500, output: 5, cacheRead: 0, records: 1 } });

  const groups = subagentModelGroups([]);
  assert.deepEqual(groups.map((g) => g.label), ['for-coding', 'step-5']);
  assert.deepEqual(groups[0].agents, ['agent-1', 'agent-2']);
  assert.equal(groups[0].totals.inputTokens + groups[0].totals.cacheReadTokens, 3000);
  assert.deepEqual(groups[1].agents, ['agent-3']);
  panel.secondaryModelName = '';
  resetSessionAgents();
});

test('panel-app：重放的历史事件不进计数器，断线补发按序号去重', async () => {
  const { window } = createPage();
  try {
    setVisibleConfig(window);
    const ready = new Promise((resolve) => window.addEventListener('kcm:panel-ready', resolve));
    injectScript(window, 'dist/panel-app.js');
    await ready;
    await tick(window);
    const push = (msg) => window.__kcm.push(msg);
    const text = (id) => window.document.getElementById(id).textContent;
    const step = (extra) => push({
      v: 1,
      type: 'event',
      event: {
        type: 'turn.step.completed',
        payload: { usage: { inputOther: 5000, inputCacheRead: 0, output: 100 } },
        ...extra
      }
    });

    // 订阅应答之前到达的是整段历史：面板数字已由本地汇总做底，重放不许再累加
    step({ kcmReplay: true, kcmReplayHistory: true, seq: 10 });
    assert.equal(text('ksb-input-tokens'), '0', '历史重放不进计数器');
    assert.equal(text('ksb-output-tokens'), '0');

    // 游标非 0 的重放是断线期间漏掉的那段：计入
    step({ kcmReplay: true, kcmReplayHistory: false, seq: 12 });
    assert.equal(text('ksb-input-tokens'), '5k', '断线补发的水位之后要计入');

    // 同一条重放再来一次（同一序号）：不再累加
    step({ kcmReplay: true, kcmReplayHistory: false, seq: 12 });
    assert.equal(text('ksb-input-tokens'), '5k', '重复序号不得双算');

    // 实时事件（非重放）照常计
    step({ seq: 13 });
    assert.equal(text('ksb-input-tokens'), '10k');
  } finally {
    window.close();
  }
});

test('panel-app：外部账户结果直接生效（唯一来源是直连抓取，没有第二路）', async () => {
  const { window } = createPage();
  try {
    setVisibleConfig(window);
    const ready = new Promise((resolve) => window.addEventListener('kcm:panel-ready', resolve));
    injectScript(window, 'dist/panel-app.js');
    await ready;
    await tick(window);
    const push = (msg) => window.__kcm.push(msg);
    // 前缀与数字各自成 span（过窄时前缀先让位、数字永不动），分别断言
    const rows = () => [...window.document.querySelectorAll('#ksb-external-list .ksb-external-row')]
      .map((row) => [
        row.querySelector('.ksb-external-name').textContent.trim(),
        row.querySelector('.ksb-external-kind')?.textContent.trim() || '',
        // 有数字 span 就读数字；没有（整段是「获取失败」这类提示语）就回退读整段
        row.querySelector('.ksb-external-amount')?.textContent.trim()
          || row.querySelector('.ksb-external-value').textContent.trim()
      ]);
    const balance = (total) => ({
      id: 'ext-deepseek-0b71', provider: 'deepseek', name: 'deepseek', keyTail: '0b71',
      kind: 'balance', currency: '¥', total, granted: 0, paid: 0, windows: [], error: ''
    });

    // 一轮抓取（每 60 秒一次）：进列表
    push({
      v: 1, type: 'external', providers: [balance(6.7)],
      unsupported: [{ id: 'StepFun Step Plan', host: 'api.stepfun.com', reason: '暂无该供应商的余额查询适配' }]
    });
    assert.deepEqual(rows(), [['deepseek', 'API余额', '¥6.70']]);

    // 下一轮拿到新值：直接覆盖，不需要任何来源优先级判定
    push({ v: 1, type: 'external', providers: [balance(5.2)] });
    assert.deepEqual(rows(), [['deepseek', 'API余额', '¥5.20']]);
  } finally {
    window.close();
  }
});

test('panel-app：接口失败沿用上次成功的数字，年龄写在类型前缀位置；从未成功过才显示「获取失败」', async () => {
  const { window } = createPage();
  try {
    setVisibleConfig(window);
    const ready = new Promise((resolve) => window.addEventListener('kcm:panel-ready', resolve));
    injectScript(window, 'dist/panel-app.js');
    await ready;
    await tick(window);
    const push = (msg) => window.__kcm.push(msg);
    // 前缀与数字各自成 span（过窄时前缀先让位、数字永不动），分别断言
    const rows = () => [...window.document.querySelectorAll('#ksb-external-list .ksb-external-row')]
      .map((row) => [
        row.querySelector('.ksb-external-name').textContent.trim(),
        row.querySelector('.ksb-external-kind')?.textContent.trim() || '',
        // 有数字 span 就读数字；没有（整段是「获取失败」这类提示语）就回退读整段
        row.querySelector('.ksb-external-amount')?.textContent.trim()
          || row.querySelector('.ksb-external-value').textContent.trim()
      ]);
    const titles = () => [...window.document.querySelectorAll('#ksb-external-list .ksb-external-row')]
      .map((row) => row.getAttribute('title') || '');
    const threeMinAgo = Date.now() - 3 * 60_000;
    const good = (id, name, total) => ({
      id, provider: 'deepseek', name, keyTail: '0b71', kind: 'balance',
      currency: '¥', total, granted: 0, paid: 0, windows: [], error: '', fetchedAt: threeMinAgo
    });

    // ① 有上次成功值：显示旧数字，前缀位置是数字年龄，悬停带失败原因
    push({
      v: 1, type: 'external',
      providers: [
        { ...good('ext-a', 'deepseek', 6.7), error: 'HTTP 503' },
        // ② 从未成功过（没有 fetchedAt）：显示「获取失败」
        { id: 'ext-b', provider: 'deepseek', name: 'moonshot', keyTail: 'ff02', kind: 'balance', error: 'Key 无效或已过期（401）' }
      ]
    });
    assert.deepEqual(rows(), [
      ['deepseek', '3 分钟前', '¥6.70'], // 失败时前缀位置是数字年龄
      ['moonshot', '', '获取失败'] // 从未成功过：整段是提示语，没有前缀/数字分层
    ]);
    assert.match(titles()[0], /3 分钟前 · HTTP 503/);
    assert.match(titles()[1], /Key 无效或已过期（401）/);
  } finally {
    window.close();
  }
});

test('panel-app：未适配的供应商不进外部账户列表，只在模块设置与提示里', async () => {
  const { window } = createPage();
  try {
    setVisibleConfig(window);
    const ready = new Promise((resolve) => window.addEventListener('kcm:panel-ready', resolve));
    injectScript(window, 'dist/panel-app.js');
    await ready;
    await tick(window);
    window.__kcm.push({
      v: 1, type: 'external', live: true, fetchedAt: new Date().toISOString(),
      providers: [],
      unsupported: [
        { id: 'StepFun Step Plan', host: 'api.stepfun.com', reason: '暂无该供应商的余额查询适配' },
        { id: '本地模型', host: '127.0.0.1', reason: '未配置 API key' }
      ]
    });
    // 方案 B：未适配的默认不显示（列表空），空态里点明"看到了但查不到"
    assert.equal(
      window.document.querySelectorAll('#ksb-external-list .ksb-external-row').length,
      0,
      '未适配的供应商不应进常规列表'
    );
    assert.match(window.document.getElementById('ksb-external-list').textContent,
      /已配置 2 个供应商，暂不支持余额查询/);
  } finally {
    window.close();
  }
});

test('panel-app：缓存提醒只显示一分钟黄色提示，随后恢复常规外观', async () => {
  const { dom, window } = createPage();
  try {
    window.localStorage.setItem('kimi-statusbar.config', JSON.stringify({
      modules: { pet: { cacheHint: true } }
    }));
    const ready = new Promise((resolve) => window.addEventListener('kcm:panel-ready', resolve));
    injectScript(window, 'dist/panel-app.js');
    await ready;
    await tick(window);
    const doc = window.document;
    const label = () => doc.getElementById('ksb-pet-label').textContent;
    const total = () => doc.getElementById('ksb-pet-total-text').textContent;
    const status = () => doc.getElementById('ksb-pet-status-text').textContent;
    const clock = () => doc.getElementById('ksb-pet-clock-num').textContent;

    assert.equal(window.__kcmCacheHint.preview, undefined);
    const timestamp = new Date(Date.now() - 29 * 60_000).toISOString();
    window.__kcm.push({ v: 1, type: 'event', event: { type: 'turn.started', timestamp, payload: {} } });
    window.__kcm.push({ v: 1, type: 'event', event: { type: 'turn.ended', timestamp, payload: {} } });
    await new Promise((resolve) => window.setTimeout(resolve, 1_100));
    assert.equal(label(), '对话缓存');
    assert.equal(total(), '即将过期');
    assert.equal(status(), '预估剩余');
    assert.match(clock(), /^\d:\d{2}$/);
    assert.ok(doc.getElementById('ksb-pet-canvas').classList.contains('ksb-cache-hot'));
    assert.ok(doc.getElementById('ksb-pet-total').classList.contains('ksb-cache-warn'));

    const idleRow = doc.createElement('div');
    idleRow.dataset.sessionId = 'cache-sidebar';
    const idleTime = doc.createElement('span');
    idleTime.textContent = '28m';
    idleRow.appendChild(idleTime);
    doc.body.appendChild(idleRow);
    window.__kcmCacheHint.seed(Date.now() - 29 * 60_000);
    await tick(window);
    assert.ok(idleTime.classList.contains('ksb-cache-idle-warn'), '28m 应标黄');

    idleTime.textContent = '31m';
    window.__kcmCacheHint.seed(Date.now() - 31 * 60_000);
    await tick(window);
    assert.ok(!idleTime.classList.contains('ksb-cache-idle-warn'), '31m 不应标黄');
    idleRow.remove();
    assert.equal(label(), '今日消耗');
    assert.ok(!doc.getElementById('ksb-pet-total').classList.contains('ksb-cache-state'));
    assert.ok(!doc.getElementById('ksb-pet-canvas').classList.contains('ksb-cache-hot'));
  } finally {
    dom.window.close();
  }
});
