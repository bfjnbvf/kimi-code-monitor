const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PROVIDERS,
  parseDeepSeek,
  parseKimiApi,
  parseZhipu,
  parseMiniMax
} = require('../providers.js');

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
        { type: 'TIME_LIMIT', percentage: 12.5 }
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

test('四家 provider 都有国内端点与凭据提示', () => {
  assert.deepEqual(Object.keys(PROVIDERS), ['deepseek', 'kimiapi', 'zhipu', 'minimax']);
  for (const provider of Object.values(PROVIDERS)) {
    assert.match(provider.origin, /^https:\/\//);
    assert.ok(provider.hint.length > 0);
  }
  assert.equal(PROVIDERS.zhipu.origin, 'https://open.bigmodel.cn');
  assert.equal(PROVIDERS.kimiapi.origin, 'https://api.moonshot.cn');
});
