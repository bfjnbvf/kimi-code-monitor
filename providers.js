/* 外部 provider 余额/额度抓取：DeepSeek、Kimi API、智谱、MiniMax。
 * 全部走国内端点，纯 REST + Bearer key。每家一个独立 fetcher，
 * 统一输出 { kind: 'balance'|'plan', ... } 供「外部账户」模块渲染。
 * 参考 CodexBar 各 provider 文档的端点与字段映射。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.KimiExternalProviders = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  async function getJson(url, key, extraHeaders = {}) {
    // 粘贴的 key 可能混入全角/不可见字符，header 只接受可见 ASCII，否则 fetch 直接抛错
    const safeKey = String(key || '').replace(/[^\x21-\x7E]/g, '');
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${safeKey}`, Accept: 'application/json', ...extraHeaders },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) {
      if (response.status === 401) throw new Error('Key 无效或已过期（401）');
      if (response.status === 403) throw new Error('没有访问权限（403）');
      throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
  }

  function toMoney(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function clampPct(value) {
    return Math.min(100, Math.max(0, value));
  }

  // 解析失败的报错带上响应截断片段：用户侧「获取失败：…」即可定位，无需抓包
  function noInfoError(message, body) {
    let snippet = '';
    try {
      snippet = JSON.stringify(body) || '';
    } catch (error) {
      snippet = '';
    }
    return new Error(snippet ? `${message}（响应：${snippet.slice(0, 150)}…）` : message);
  }

  // 套餐窗口的语义标签：按时长映射为 5h/1w/1M，缺失时按类型兜底
  function windowLabel(limit) {
    const number = Number(limit?.number ?? limit?.windowSize ?? limit?.window);
    const unit = String(limit?.unit ?? limit?.windowUnit ?? '').toLowerCase();
    if (Number.isFinite(number) && number > 0) {
      const minutes =
        number * (unit.startsWith('hour') || unit === 'h' ? 60
          : unit.startsWith('day') || unit === 'd' ? 1440
          : 1);
      if (minutes <= 360) return '5h';
      if (minutes <= 11000) return '1w';
      return '1M';
    }
    return limit?.type === 'TIME_LIMIT' ? 'MCP' : '额度';
  }

  // DeepSeek：balance_infos 按币种拆分，只取人民币（赠送/充值分列）
  function parseDeepSeek(body) {
    const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
    const cny = infos.find((info) => info?.currency === 'CNY');
    if (!cny) throw noInfoError('响应中没有人民币余额', body);
    return {
      kind: 'balance',
      total: toMoney(cny.total_balance),
      granted: toMoney(cny.granted_balance),
      paid: toMoney(cny.topped_up_balance),
      currency: '¥'
    };
  }

  // Kimi API（Moonshot 开放平台国内站）：available / voucher / cash
  function parseKimiApi(body) {
    const data = body?.data;
    if (!data || data.available_balance == null) throw noInfoError('响应中没有余额字段', body);
    return {
      kind: 'balance',
      total: toMoney(data.available_balance),
      granted: toMoney(data.voucher_balance),
      paid: toMoney(data.cash_balance),
      currency: '¥'
    };
  }

  // 智谱 coding plan：data.limits[] 各窗口。字段名公开文档未列全，做宽容解析。
  function parseZhipu(body) {
    const data = body?.data;
    const limits = Array.isArray(data?.limits) ? data.limits : [];
    const windows = [];
    for (const limit of limits) {
      const used = Number(limit?.usage ?? limit?.used ?? limit?.currentValue ?? limit?.usedValue);
      const total = Number(limit?.total ?? limit?.limit ?? limit?.totalValue ?? limit?.limitValue);
      let pct = Number(limit?.percentage ?? limit?.usagePercent ?? limit?.rate);
      if (!Number.isFinite(pct) && Number.isFinite(used) && Number.isFinite(total) && total > 0) {
        pct = (used / total) * 100;
      }
      if (!Number.isFinite(pct)) continue;
      windows.push({
        label: windowLabel(limit),
        pct,
        resetAt: Number(limit?.nextResetTime) || null
      });
    }
    if (!windows.length && !data?.planName) throw noInfoError('响应中没有额度窗口', body);
    return {
      kind: 'plan',
      plan: data?.planName || data?.plan || data?.plan_type || data?.packageName || '',
      windows
    };
  }

  // MiniMax coding plan remains：实际返回 model_remains 数组（2026-08 抓包确认），
  // 扁平字段是早期口径的兜底。字段名未公开，均做宽容解析。
  function parseMiniMax(body) {
    // Key 无效等情况 HTTP 仍为 200，错误在 base_resp 里
    const statusCode = Number(body?.base_resp?.status_code);
    if (Number.isFinite(statusCode) && statusCode !== 0) {
      throw new Error(`接口返回错误：${body?.base_resp?.status_msg || `code ${statusCode}`}`);
    }
    // model_remains：优先 general 条目；*_remaining_percent 是剩余百分比，转成已用
    const remainsList = Array.isArray(body?.model_remains) ? body.model_remains : [];
    if (remainsList.length) {
      const entry = remainsList.find((item) => item?.model_name === 'general') || remainsList[0];
      const windows = [];
      const intervalPct = Number(entry?.current_interval_remaining_percent);
      if (Number.isFinite(intervalPct)) {
        windows.push({
          label: '5h',
          pct: clampPct(100 - intervalPct),
          resetAt: Number(entry?.end_time) || null
        });
      }
      const weeklyPct = Number(entry?.current_weekly_remaining_percent);
      if (Number.isFinite(weeklyPct)) {
        windows.push({
          label: '1w',
          pct: clampPct(100 - weeklyPct),
          resetAt: Number(entry?.weekly_end_time) || null
        });
      }
      if (windows.length) return { kind: 'plan', plan: 'MiniMax Coding Plan', windows };
    }
    // 扁平字段兜底（早期口径）
    const data = body?.data ?? body;
    const windows = [];
    const used = Number(data?.used ?? data?.used_quota ?? data?.usedQuota);
    const total = Number(data?.total ?? data?.total_quota ?? data?.totalQuota ?? data?.limit);
    const remains = Number(data?.remains ?? data?.remain ?? data?.remaining ?? data?.left);
    let pct = Number(data?.percentage ?? data?.usage_percent ?? data?.usedPercent);
    if (!Number.isFinite(pct) && Number.isFinite(used) && Number.isFinite(total) && total > 0) {
      pct = (used / total) * 100;
    }
    if (!Number.isFinite(pct) && Number.isFinite(remains) && Number.isFinite(total) && total > 0) {
      pct = ((total - remains) / total) * 100;
    }
    if (Number.isFinite(pct)) {
      windows.push({
        label: windowLabel(data),
        pct,
        resetAt: Number(data?.next_reset_time ?? data?.nextResetTime ?? data?.resetTime) || null
      });
    }
    const plan = data?.plan ?? data?.plan_name ?? data?.planName ?? data?.tier ?? '';
    if (!windows.length && !plan) throw noInfoError('响应中没有额度信息', body);
    return { kind: 'plan', plan, windows };
  }

  const PROVIDERS = {
    deepseek: {
      name: 'DeepSeek',
      typeLabel: 'API余额',
      origin: 'https://api.deepseek.com',
      hint: 'platform.deepseek.com → API keys',
      async fetch(key) {
        return parseDeepSeek(await getJson('https://api.deepseek.com/user/balance', key));
      }
    },
    kimiapi: {
      name: 'Kimi API',
      typeLabel: 'API余额',
      origin: 'https://api.moonshot.cn',
      hint: 'platform.moonshot.cn → API Key 管理',
      async fetch(key) {
        return parseKimiApi(await getJson('https://api.moonshot.cn/v1/users/me/balance', key));
      }
    },
    zhipu: {
      name: '智谱',
      typeLabel: 'Token Plan',
      origin: 'https://open.bigmodel.cn',
      hint: 'bigmodel.cn → API keys',
      async fetch(key) {
        return parseZhipu(await getJson('https://open.bigmodel.cn/api/monitor/usage/quota/limit', key));
      }
    },
    minimax: {
      name: 'MiniMax',
      typeLabel: 'Token Plan',
      origin: 'https://www.minimaxi.com',
      hint: 'platform.minimaxi.com → 订阅付费 → API Key',
      async fetch(key) {
        return parseMiniMax(
          await getJson('https://www.minimaxi.com/v1/token_plan/remains', key)
        );
      }
    }
  };

  return {
    PROVIDERS,
    parseDeepSeek,
    parseKimiApi,
    parseZhipu,
    parseMiniMax
  };
});
