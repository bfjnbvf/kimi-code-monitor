/* 会话智能命名：模型调用（仅 background 使用，importScripts 加载）。
 * 两路来源：
 * 1. Kimi Code 账户（默认）：设备 OAuth token 调 api.kimi.com 的 Anthropic 格式端点。
 *    注意：此端点能否用设备 token 未实测——401/403/404 一律返回结构化错误，
 *    由 UI 提示改用外部账户，不重试、不静默烧额度。
 * 2. 外部账户：OpenAI 兼容 chat/completions，key 由 background 解密后传入。
 * 统一返回 { ok:true, text } 或 { ok:false, code, error }。 */
'use strict';

import './rename-shared.js';

const KIMI_CODE_MESSAGES_API = 'https://api.kimi.com/coding/v1/messages';
// Kimi Code 账户命名的默认模型（单价更低；popup 下拉可另选 kimi-code/* 模型，调用时传入）
const KIMI_CODE_MODEL = 'kimi-code/kimi-for-coding';
// kimi-for-coding 强制思考且思考较慢（实测一次调用 ~20s），30s 超时曾撞墙，放宽到 90s
const REQUEST_TIMEOUT_MS = 90_000;
// kimi-code 系列模型 always_thinking：思考段会消耗输出预算，
// max_tokens 太小会整段被思考占完、正文为空，故留足余量（标题本身 ≤100 token）
const MAX_TOKENS = 1_000;
const TEMPERATURE = 0.2;

/* 支持命名的外部 provider（OpenAI 兼容端点）。
 * 与 providers.js 的 origin 保持一致；新增一家只需在这里加一行。
 * model 是兜底默认（模型列表拉取失败时使用）；popup 下拉展示的是
 * 通过 modelsUrl 实时拉取的具体模型，不再只显示账户名。
 * 注意 deepseek-chat / deepseek-reasoner 已于 2026-07-24 退役，
 * 默认模型必须用现行 ID（deepseek-v4-flash / deepseek-v4-pro）。 */
const RENAME_MODEL_PROVIDERS = {
  kimiapi: {
    endpoint: 'https://api.moonshot.cn/v1/chat/completions',
    modelsUrl: 'https://api.moonshot.cn/v1/models',
    model: 'moonshot-v1-8k'
  },
  deepseek: {
    endpoint: 'https://api.deepseek.com/chat/completions',
    modelsUrl: 'https://api.deepseek.com/models',
    model: 'deepseek-v4-flash'
  }
};

function ok(text, usage = null) {
  return { ok: true, text, usage };
}

// 从响应里提取 token 用量（Anthropic / OpenAI 两种形状），取不到返回 null。
// 注意 Anthropic 的 input_tokens 不含缓存部分（cache_read/cache_creation），
// 只统计它会导致「输入看起来特别少」——缓存读写也是真实消耗，一并计入输入。
function extractUsage(data) {
  const usage = data?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const input = Number(usage.input_tokens ?? usage.prompt_tokens);
  const output = Number(usage.output_tokens ?? usage.completion_tokens);
  if (!Number.isFinite(input) && !Number.isFinite(output)) return null;
  const cacheRead = Number(usage.cache_read_input_tokens) || 0;
  const cacheCreate = Number(usage.cache_creation_input_tokens) || 0;
  return {
    input: (Number.isFinite(input) ? input : 0) + cacheRead + cacheCreate,
    output: Number.isFinite(output) ? output : 0
  };
}

function fail(code, error) {
  return { ok: false, code, error };
}

async function httpFail(label, response) {
  const status = response.status;
  let detail = '';
  try {
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    detail = data?.error?.message || data?.message || data?.error || '';
  } catch (error) {
    // 响应体不是 JSON 时忽略解析错误，只保留状态码
  }
  if (status === 429) {
    return fail('MODEL_RATE_LIMITED', '命名模型触发限流（HTTP 429），请稍后重试');
  }
  if (status >= 500) {
    return fail('MODEL_SERVER_ERROR', `命名模型服务端错误（HTTP ${status}），请稍后重试`);
  }
  if (status === 401 || status === 403) {
    return fail('AUTH_KEY_INVALID', `API Key 无效或权限不足（HTTP ${status}），请检查外部账户`);
  }
  return fail('MODEL_REQUEST_INVALID', `命名模型请求无效（HTTP ${status}）${detail ? `：${detail}` : ''}`);
}

// Kimi Code 账户：Anthropic messages 格式；设备 token 未实测，鉴权类状态直接结构化报错
async function callKimiCode(accessToken, prompt, model = KIMI_CODE_MODEL) {
  let response;
  try {
    response = await fetch(KIMI_CODE_MESSAGES_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: model || KIMI_CODE_MODEL,
        max_tokens: MAX_TOKENS,
        temperature: TEMPERATURE,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    return fail('MODEL_NETWORK_ERROR', `命名模型请求失败：${error?.message || error}`);
  }
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    return fail('KIMI_MODEL_UNAVAILABLE', 'Kimi Code 账户无法调用模型，请改用外部账户');
  }
  if (!response.ok) return httpFail('命名模型', response);
  const data = await response.json().catch(() => null);
  // Anthropic 格式：content 为 [{ type:'text', text }] 数组（可能混有 thinking 块）
  const text = (Array.isArray(data?.content) ? data.content : [])
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
    .trim();
  if (!text) {
    // 诊断信息：stop_reason 与 content 块类型，便于定位思考截断/格式漂移
    const blockTypes = (Array.isArray(data?.content) ? data.content : [])
      .map((part) => part?.type || '?')
      .join(',') || 'none';
    return fail(
      'MODEL_EMPTY_RESPONSE',
      `命名模型返回为空（stop_reason: ${data?.stop_reason || '?'}，content: ${blockTypes}）`
    );
  }
  return ok(text, extractUsage(data));
}

// 外部账户：OpenAI 兼容 chat/completions；model 缺省用 provider 兜底默认
async function callExternal(providerId, key, prompt, model) {
  const target = RENAME_MODEL_PROVIDERS[providerId];
  if (!target) return fail('PROVIDER_UNSUPPORTED', '该外部账户不支持会话命名');
  if (model === '' || (!model && !target.model)) return fail('MODEL_ID_REQUIRED', '未指定模型 ID');
  const modelId = model || target.model;
  let response;
  try {
    response = await fetch(target.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: MAX_TOKENS,
        temperature: TEMPERATURE,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    return fail('MODEL_NETWORK_ERROR', `命名模型请求失败：${error?.message || error}`);
  }
  if (!response.ok) return httpFail('命名模型', response);
  const data = await response.json().catch(() => null);
  const text = String(data?.choices?.[0]?.message?.content || '').trim();
  if (!text) return fail('MODEL_EMPTY_RESPONSE', '命名模型返回为空');
  return ok(text, extractUsage(data));
}

const KimiSessionRenameModel = {
  KIMI_CODE_MODEL,
  RENAME_MODEL_PROVIDERS,
  callKimiCode,
  callExternal
};

export {
  KIMI_CODE_MODEL,
  RENAME_MODEL_PROVIDERS,
  callKimiCode,
  callExternal,
  KimiSessionRenameModel
};
