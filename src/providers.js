/* 外部 provider 余额/额度抓取：DeepSeek、Kimi API、智谱、MiniMax、阶跃星辰。
 * 全部走国内端点，纯 REST + Bearer key。每家一个独立 fetcher，
 * 统一输出 { kind: 'balance'|'plan', ... } 供「外部账户」模块渲染。
 * 参考 CodexBar 各 provider 文档的端点与字段映射。
 */
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

// 控制台类接口：不是 Bearer API Key，而是网页登录态 token（如 StepFun 的
// Oasis-Token）。单独一个 fetch，避免把控制台 token 误当 API Key 发出去。
async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(15_000)
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error('控制台 Token 无效或已过期（401/403）');
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
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

// 套餐窗口的语义标签：智谱的 TIME_LIMIT 是 MCP 月度额度，必须优先于
// number/unit 的通用时长映射——该类型即使带 number/unit（如 1 month），
// 通用分支也会把 month 当成 1 分钟并误标成 5h（issue #13）。
function windowLabel(limit) {
  if (limit?.type === 'TIME_LIMIT') return 'MCP';
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
  return '额度';
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

// 阶跃星辰 StepFun：GET /v1/accounts 返回账户余额（预付费 balance / 充值 / 赠送，
// 单位元）。文档：platform.stepfun.com/docs/api-reference/accounts/get。
// 注意客户端里的 provider 多配成 Step Plan（base_url 带 /step_plan/v1 路径），
// 识别只认域名，余额端点固定用 apex 域的 /v1/accounts。
function parseStepFun(body) {
  if (body?.balance == null) throw noInfoError('响应中没有余额字段', body);
  return {
    kind: 'balance',
    total: toMoney(body.balance),
    granted: toMoney(body.total_voucher_balance),
    paid: toMoney(body.total_cash_balance),
    currency: '¥'
  };
}

/* StepFun Step Plan 订阅额度（控制台接口，未实测）
 *
 * 与按量余额是两套东西：
 *  - 模型调用用 Step API Key，base_url 是 api.stepfun.com/step_plan/v1
 *  - 额度查询是 platform.stepfun.com 的网页控制台 RPC，使用登录态里的
 *    Oasis-Token（不是 API Key），端点与字段来自社区实现（codex-switcher /
 *    cc-switch 的抓包），官方没有公开文档。
 *
 * 因为无法用 API Key 自动查询，本适配只在“手动添加外部账户”里可用：
 * 用户粘贴 Oasis-Token，后台用 Oasis-* 头请求。桌面客户端自动发现的
 * Step Plan 供应商会显示“需要控制台 Token”，不会拿 API Key 去误试。
 */
function consoleSeconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  // 有的字段是秒，有的是毫秒；2e10 秒已经是公元 2603 年，超过就是毫秒
  return number > 20_000_000_000 ? number : number * 1000;
}

function stepFunLeftPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  // 字段名 left_rate：0~1 或 0~100 两种口径都出现过
  return clampPct(number <= 1 ? number * 100 : number);
}

function parseStepFunPlan(body) {
  const rate = body?.plan_credit_rate_limit ?? body?.planCreditRateLimit ?? body;
  const windows = [];

  const buckets = rate?.credit_buckets ?? rate?.creditBuckets;
  for (const bucket of Array.isArray(buckets) ? buckets : []) {
    const total = Number(bucket?.credit_total ?? bucket?.creditTotal);
    const residual = Number(bucket?.credit_residual ?? bucket?.creditResidual);
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(residual)) continue;
    const type = String(bucket?.type ?? '');
    const label = type.includes('TOPUP') || type === '2' ? '加油包' : '订阅';
    const resetAt = consoleSeconds(
      bucket?.next_reset_at ?? bucket?.nextResetAt ?? bucket?.expire_at ?? bucket?.expireAt
    );
    windows.push({ label, pct: clampPct((1 - residual / total) * 100), resetAt });
  }

  // 没有 credit_buckets 时用两个“剩余比例”兜底（同样是 0~1 或 0~100）
  if (!windows.length) {
    const subscriptionLeft = stepFunLeftPercent(
      rate?.subscription_credit_left_rate ?? rate?.subscriptionCreditLeftRate
    );
    if (subscriptionLeft != null) {
      windows.push({
        label: '订阅',
        pct: clampPct(100 - subscriptionLeft),
        resetAt: consoleSeconds(
          rate?.subscription_credit_reset_time ?? rate?.subscriptionCreditResetTime
        )
      });
    }
    const topupLeft = stepFunLeftPercent(
      rate?.topup_credit_left_rate ?? rate?.topupCreditLeftRate
    );
    if (topupLeft != null) {
      windows.push({
        label: '加油包',
        pct: clampPct(100 - topupLeft),
        resetAt: consoleSeconds(rate?.topup_credit_reset_time ?? rate?.topupCreditResetTime)
      });
    }
  }

  if (!windows.length) throw noInfoError('响应中没有 Step Plan 额度窗口', body);
  return { kind: 'plan', plan: 'Step Plan', windows };
}

// 用户可能直接粘 token，也可能粘整段 Cookie（Oasis-Token=...）或带前缀的文本
function normalizeStepFunConsoleToken(raw) {
  let text = String(raw || '').trim();
  const lower = text.toLowerCase();
  const cookieIndex = lower.indexOf('cookie:');
  if (cookieIndex >= 0) text = text.slice(cookieIndex + 'cookie:'.length);
  const tokenIndex = lower.indexOf('oasis-token:');
  if (tokenIndex >= 0) text = text.slice(tokenIndex + 'oasis-token:'.length);
  text = text.split(/\r?\n/)[0].trim().replace(/^['"`\\]+|['"`\\]+$/g, '');
  for (const pair of text.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name && name.trim().toLowerCase() === 'oasis-token') {
      const value = rest.join('=').trim().replace(/^['"]|['"]$/g, '');
      if (value) return value;
    }
  }
  return text.includes('=') ? '' : text;
}

const PROVIDERS = {
  deepseek: {
    name: 'DeepSeek',
    typeLabel: 'API余额',
    origin: 'https://api.deepseek.com',
    hosts: ['api.deepseek.com'],
    hint: 'platform.deepseek.com → API keys',
    async fetch(key) {
      return parseDeepSeek(await getJson('https://api.deepseek.com/user/balance', key));
    }
  },
  kimiapi: {
    name: 'Kimi API',
    typeLabel: 'API余额',
    origin: 'https://api.moonshot.cn',
    hosts: ['api.moonshot.cn'],
    hint: 'platform.moonshot.cn → API Key 管理',
    async fetch(key) {
      return parseKimiApi(await getJson('https://api.moonshot.cn/v1/users/me/balance', key));
    }
  },
  zhipu: {
    name: '智谱',
    typeLabel: 'Token Plan',
    origin: 'https://open.bigmodel.cn',
    hosts: ['open.bigmodel.cn'],
    hint: 'bigmodel.cn → API keys',
    async fetch(key) {
      return parseZhipu(await getJson('https://open.bigmodel.cn/api/monitor/usage/quota/limit', key));
    }
  },
  minimax: {
    name: 'MiniMax',
    typeLabel: 'Token Plan',
    origin: 'https://www.minimaxi.com',
    hosts: ['minimaxi.com', 'minimax.io'],
    hint: 'platform.minimaxi.com → 订阅付费 → API Key',
    async fetch(key) {
      return parseMiniMax(
        await getJson('https://www.minimaxi.com/v1/token_plan/remains', key)
      );
    }
  },
  stepfunplan: {
    name: '阶跃星辰 Step Plan',
    typeLabel: '订阅额度（未实测）',
    origin: 'https://platform.stepfun.com',
    hosts: ['api.stepfun.com'],
    paths: ['/step_plan'],
    credential: 'console-token',
    credentialHint: '需要 platform.stepfun.com 的 Oasis-Token（不是 API Key；未实测）',
    hint: 'platform.stepfun.com 登录后从 Cookie 复制 Oasis-Token（未实测）',
    async fetch(token) {
      const consoleToken = normalizeStepFunConsoleToken(token);
      if (!consoleToken) throw new Error('需要 platform.stepfun.com 的 Oasis-Token（不是 API Key）');
      return parseStepFunPlan(await postJson(
        'https://platform.stepfun.com/api/step.openapi.devcenter.Dashboard/QueryStepPlanRateLimit',
        {},
        {
          'Oasis-Token': consoleToken,
          'Oasis-AppID': '10300',
          'Oasis-Platform': 'web'
        }
      ));
    }
  },
  stepfun: {
    name: '阶跃星辰 StepFun',
    typeLabel: 'API余额',
    origin: 'https://api.stepfun.com',
    hosts: ['api.stepfun.com'],
    hint: 'platform.stepfun.com → API Keys',
    async fetch(key) {
      return parseStepFun(await getJson('https://api.stepfun.com/v1/accounts', key));
    }
  }
};

/* 已知但当前凭证模型接不上的额度接口：给出精确原因，别让用户以为是 key 填错了。
 *  - 火山方舟：控制面 OpenAPI GetCodingPlanUsage / GetAFPUsage 要 AK/SK 签名，
 *    推理 API Key 调用会 InvalidAuthorization；
 *  - 阿里云百炼：Coding Plan / Token Plan 用量目前只在控制台页面可见，没有公开接口。
 * 这两家等社区实测出稳定端点/授权方式后再补适配（欢迎提 issue / PR）。 */
const UNSUPPORTED_CLIENT_HOSTS = [
  {
    test: (host) => host.endsWith('.volces.com') || host.endsWith('.volcengineapi.com'),
    reason: '火山方舟 Coding/Agent Plan 额度需要 AK/SK 签名，推理 API Key 查不了（暂未适配）'
  },
  {
    test: (host) => host === 'dashscope.aliyuncs.com'
      || host.endsWith('.dashscope.aliyuncs.com')
      || host === 'bailian.aliyuncs.com'
      || host.endsWith('.bailian.aliyuncs.com'),
    reason: '百炼 Coding/Token Plan 用量目前仅控制台可见，暂无公开额度接口（暂未适配）'
  }
];

/* ---------- 客户端 provider 的识别与分类（面板与技能共用这一份） ---------- */

/** base_url → 主机名（小写、去端口）；解析不了返回空串 */
function hostOf(baseUrl) {
  try {
    return new URL(String(baseUrl || '')).hostname.toLowerCase();
  } catch (error) {
    return '';
  }
}

/** 按 base_url 的域名找适配器。
 *  只能按域名认：客户端里的 provider 名字是用户自己起的，本机就有
 *  `StepFun Step Plan`（带空格）这种 id，按名字匹配必然漏。 */
function adapterForBaseUrl(baseUrl) {
  const host = hostOf(baseUrl);
  if (!host) return null;
  let pathname = '';
  try {
    pathname = new URL(String(baseUrl)).pathname.toLowerCase();
  } catch (error) {
    pathname = '';
  }
  for (const [id, provider] of Object.entries(PROVIDERS)) {
    const hosts = Array.isArray(provider.hosts) ? provider.hosts : [];
    if (!hosts.some((h) => host === h || host.endsWith(`.${h}`))) continue;
    // 同一域名下有多条通道时用 path 区分（如 StepFun 的 /step_plan 与按量 /v1）
    const paths = Array.isArray(provider.paths) ? provider.paths : null;
    if (paths && !paths.some((p) => pathname.startsWith(p))) continue;
    return { adapterId: id, adapter: provider, host };
  }
  return null;
}

/** 客户端 provider 条目 → 面板该怎么处理（三类）：
 *  - supported：有余额/额度端点，可实时查询
 *  - managed：客户端托管账号（额度走 /api/v1/oauth/usage，已在面板顶部显示，不重复列）
 *  - unsupported：没有对应端点（厂商未开放余额接口，或我们还没适配） */
function classifyClientProvider(entry) {
  const baseUrl = typeof entry?.base_url === 'string' ? entry.base_url : '';
  const host = hostOf(baseUrl);
  const type = typeof entry?.type === 'string' ? entry.type : '';
  if (type === 'kimi' || host === 'api.kimi.com') {
    return { kind: 'managed', host, reason: '客户端托管账号（额度见面板顶部）' };
  }
  // 已知但凭证模型接不上的厂商：先给出真实原因，别落到泛化的「暂无适配」
  for (const entryInfo of UNSUPPORTED_CLIENT_HOSTS) {
    if (entryInfo.test(host)) {
      return { kind: 'unsupported', host, reason: entryInfo.reason };
    }
  }
  const match = adapterForBaseUrl(baseUrl);
  if (match) {
    // 控制台 Token / AK-SK 类适配器不能用客户端里的模型 API Key 自动查询
    if (match.adapter.credential && match.adapter.credential !== 'api-key') {
      return {
        kind: 'unsupported',
        host,
        reason: match.adapter.credentialHint || '该供应商需要额外的控制台凭据，不能用 API Key 查询'
      };
    }
    return {
      kind: 'supported',
      host,
      adapterId: match.adapterId,
      adapter: match.adapter,
      typeLabel: match.adapter.typeLabel
    };
  }
  return { kind: 'unsupported', host, reason: '暂无该供应商的余额查询适配' };
}

const KimiExternalProviders = {
  PROVIDERS,
  adapterForBaseUrl,
  classifyClientProvider,
  hostOf,
  parseDeepSeek,
  parseKimiApi,
  parseZhipu,
  parseMiniMax,
  parseStepFun,
  parseStepFunPlan
};

export {
  PROVIDERS,
  adapterForBaseUrl,
  classifyClientProvider,
  hostOf,
  parseDeepSeek,
  parseKimiApi,
  parseZhipu,
  parseMiniMax,
  parseStepFun,
  parseStepFunPlan,
  KimiExternalProviders
};
