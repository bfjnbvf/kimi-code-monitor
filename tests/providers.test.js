import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROVIDERS,
  adapterForBaseUrl,
  classifyClientProvider,
  hostOf,
  parseDeepSeek,
  parseKimiApi,
  parseZhipu,
  parseMiniMax,
  parseStepFun
} from '../src/providers.js';

test('DeepSeek 只取人民币余额并拆分赠送/充值', () => {
  const result = parseDeepSeek({
    is_available: true,
    balance_infos: [
      { currency: 'USD', total_balance: '9.99', granted_balance: '0', topped_up_balance: '9.99' },
      { currency: 'CNY', total_balance: '50.00', granted_balance: '10.00', topped_up_balance: '40.00' }
    ]
  });
  assert.equal(result.kind, 'balance');
  assert.equal(result.currency, '¥');
  assert.equal(result.total, 50);
  assert.equal(result.granted, 10);
  assert.equal(result.paid, 40);
  assert.throws(() => parseDeepSeek({ balance_infos: [] }), /人民币/);
});

test('Kimi API 余额取 available/voucher/cash', () => {
  const result = parseKimiApi({
    data: { available_balance: '123.45', voucher_balance: '23.45', cash_balance: '100.00' }
  });
  assert.equal(result.total, 123.45);
  assert.equal(result.granted, 23.45);
  assert.equal(result.paid, 100);
  assert.throws(() => parseKimiApi({ data: {} }));
});

test('智谱 coding plan 窗口做宽容解析，无窗口无套餐时报错', () => {
  const result = parseZhipu({
    data: {
      planName: 'Coding Plan Pro',
      limits: [
        { type: 'TOKENS_LIMIT', usage: 40, total: 100, nextResetTime: 1786000000000 },
        // 真实响应带 number/unit（1 month）；TIME_LIMIT 必须优先判为 MCP（issue #13）
        { type: 'TIME_LIMIT', percentage: 12.5, number: 1, unit: 'month', nextResetTime: 1786000000000 }
      ]
    }
  });
  assert.equal(result.kind, 'plan');
  assert.equal(result.plan, 'Coding Plan Pro');
  assert.equal(result.windows.length, 2);
  assert.equal(result.windows[0].pct, 40);
  assert.equal(result.windows[0].resetAt, 1786000000000);
  assert.equal(result.windows[1].label, 'MCP');
  assert.throws(() => parseZhipu({ data: {} }));
});

test('MiniMax remains 支持 used/total 与 remains/total 两种口径', () => {
  const byUsed = parseMiniMax({ data: { used: 30, total: 100, plan: 'Starter' } });
  assert.equal(byUsed.windows[0].pct, 30);
  const byRemains = parseMiniMax({ data: { remains: 25, total: 100 } });
  assert.equal(byRemains.windows[0].pct, 75);
  assert.throws(() => parseMiniMax({ data: {} }));
});

test('MiniMax model_remains：取 general 条目，剩余百分比转已用，带重置时间', () => {
  const body = {
    model_remains: [
      {
        model_name: 'general',
        end_time: 1785772800000,
        weekly_end_time: 1786291200000,
        current_interval_remaining_percent: 80,
        current_weekly_remaining_percent: 95
      },
      { model_name: 'video', current_interval_remaining_percent: 10, current_weekly_remaining_percent: 20 }
    ],
    base_resp: { status_code: 0, status_msg: 'success' }
  };
  const result = parseMiniMax(body);
  assert.equal(result.kind, 'plan');
  assert.deepEqual(result.windows, [
    { label: '5h', pct: 20, resetAt: 1785772800000 },
    { label: '1w', pct: 5, resetAt: 1786291200000 }
  ]);
});

test('MiniMax model_remains：无 general 取第一条；base_resp 非零报接口错误', () => {
  const only = parseMiniMax({
    model_remains: [{ model_name: 'video', current_interval_remaining_percent: 60 }]
  });
  assert.equal(only.windows.length, 1);
  assert.equal(only.windows[0].pct, 40);
  assert.throws(
    () => parseMiniMax({ base_resp: { status_code: 1002, status_msg: 'invalid api key' } }),
    /invalid api key/
  );
});

test('阶跃星辰 StepFun：balance/充值/赠送三元映射，缺字段报错', () => {
  const result = parseStepFun({
    object: 'account',
    type: 'prepaid',
    balance: 13.23,
    total_cash_balance: 50,
    total_voucher_balance: 26
  });
  assert.equal(result.kind, 'balance');
  assert.equal(result.currency, '¥');
  assert.equal(result.total, 13.23);
  assert.equal(result.paid, 50);
  assert.equal(result.granted, 26);
  // 字符串数字也认（接口返回 float，宽松起见不挑类型）
  assert.equal(parseStepFun({ balance: '6.70', total_cash_balance: '5.70', total_voucher_balance: '1' }).total, 6.7);
  assert.throws(() => parseStepFun({ object: 'account' }), /余额/);
});

test('五家 provider 都有国内端点与凭据提示', () => {
  assert.deepEqual(Object.keys(PROVIDERS), ['deepseek', 'kimiapi', 'zhipu', 'minimax', 'stepfun']);
  for (const provider of Object.values(PROVIDERS)) {
    assert.match(provider.origin, /^https:\/\//);
    assert.ok(provider.hint.length > 0);
  }
  assert.equal(PROVIDERS.zhipu.origin, 'https://open.bigmodel.cn');
  assert.equal(PROVIDERS.kimiapi.origin, 'https://api.moonshot.cn');
  assert.equal(PROVIDERS.stepfun.origin, 'https://api.stepfun.com');
});

/* ---------- 客户端供应商的识别与分类 ----------
 * 外部账户的来源是客户端自己的 provider 配置，名字是用户随便起的（本机真实
 * 数据里就有 `StepFun Step Plan` 这种带空格的 id），所以只能按 base_url 的
 * 域名认。面板与技能脚本共用这一份判断。 */

test('hostOf：取主机名、统一小写、去端口', () => {
  assert.equal(hostOf('https://api.deepseek.com'), 'api.deepseek.com');
  assert.equal(hostOf('https://API.DeepSeek.com/user/balance'), 'api.deepseek.com');
  assert.equal(hostOf('http://127.0.0.1:11434/v1'), '127.0.0.1');
  assert.equal(hostOf('不是URL'), '');
  assert.equal(hostOf(''), '');
  assert.equal(hostOf(undefined), '');
});

test('按域名识别适配器：子域、大小写、路径都不影响', () => {
  assert.equal(adapterForBaseUrl('https://api.deepseek.com')?.adapterId, 'deepseek');
  assert.equal(adapterForBaseUrl('https://api.deepseek.com/v1/')?.adapterId, 'deepseek');
  assert.equal(adapterForBaseUrl('https://API.MOONSHOT.CN/v1')?.adapterId, 'kimiapi');
  assert.equal(adapterForBaseUrl('https://open.bigmodel.cn/api/paas/v4')?.adapterId, 'zhipu');
  assert.equal(adapterForBaseUrl('https://www.minimaxi.com/v1')?.adapterId, 'minimax');
  // Step Plan 的 base_url 带路径，也只认域名（用户真实配置就是这样）
  assert.equal(adapterForBaseUrl('https://api.stepfun.com/step_plan/v1')?.adapterId, 'stepfun');
  // 未适配的域名不做猜测：各家的余额路径/鉴权/字段都不一样，猜就是误报
  // （小米 MiMo 只有平台 Cookie 用法，明确不进适配表）
  assert.equal(adapterForBaseUrl('https://api.xiaomimimo.com/v1'), null);
  assert.equal(adapterForBaseUrl('https://api.stepfun.ai/step_plan/v1'), null);
  assert.equal(adapterForBaseUrl('http://127.0.0.1:11434/v1'), null);
});

test('三类分类：已接入 / 未适配 / 客户端托管账号', () => {
  const supported = classifyClientProvider({
    id: 'deepseek', type: 'openai', base_url: 'https://api.deepseek.com', has_api_key: true
  });
  assert.equal(supported.kind, 'supported');
  assert.equal(supported.adapterId, 'deepseek');
  assert.equal(supported.host, 'api.deepseek.com');

  // 名字带空格、大小写混杂也要认出来（真实数据里就是这样）——Step Plan 已接入
  const stepPlan = classifyClientProvider({
    id: 'StepFun Step Plan', type: 'openai', base_url: 'https://api.stepfun.com/step_plan/v1', has_api_key: true
  });
  assert.equal(stepPlan.kind, 'supported');
  assert.equal(stepPlan.adapterId, 'stepfun');
  assert.equal(stepPlan.host, 'api.stepfun.com');

  // 小米 MiMo：只有平台登录 Cookie 用法，无 key 可达的余额端点——明确未适配
  const xiaomi = classifyClientProvider({
    id: 'Xiaomi', type: 'openai', base_url: 'https://api.xiaomimimo.com/v1', has_api_key: true
  });
  assert.equal(xiaomi.kind, 'unsupported');
  assert.equal(xiaomi.host, 'api.xiaomimimo.com');

  // 客户端托管账号：额度走 /api/v1/oauth/usage，面板顶部已在显示，不重复列
  const managed = classifyClientProvider({
    id: 'managed:kimi-code', type: 'kimi', base_url: 'https://api.kimi.com/coding/v1', has_api_key: true
  });
  assert.equal(managed.kind, 'managed');

  // 地址缺失 / 非法：按未适配处理，绝不当成支持
  assert.equal(classifyClientProvider({ id: 'x', type: 'openai' }).kind, 'unsupported');
  assert.equal(classifyClientProvider({ id: 'x', type: 'openai', base_url: 'nope' }).kind, 'unsupported');
  assert.equal(classifyClientProvider(null).kind, 'unsupported');
});

test('适配表每家都带小写的 hosts（识别只认它，不看 provider 名字）', () => {
  for (const [id, provider] of Object.entries(PROVIDERS)) {
    assert.ok(Array.isArray(provider.hosts) && provider.hosts.length > 0, `${id} 缺 hosts`);
    for (const host of provider.hosts) {
      assert.equal(typeof host, 'string');
      assert.equal(host, host.toLowerCase(), `${id} 的 host 应小写：${host}`);
    }
  }
});
