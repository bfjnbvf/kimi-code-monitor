/**
 * 独立额度采集：本机服务优先，官方接口兜底；复用仓库鉴权和统计函数。
 * Separate quota worker: prefer local Kimi, fall back to the official API, reuse repository helpers.
 * 令牌只进请求头，缓存只有额度与时间。 / Tokens stay in headers; cache only quota and timestamps.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kapAuthHeaders } from '../kap-auth.mjs';
import { quotaPercentage } from '../metrics.js';

export function normalizeQuota(body) {
  // 兼容三种接口结构；空值不算 0%。 / Accept three response shapes; missing data is not zero usage.
  const managed = body?.data?.quota?.usages;
  const modern = body?.usages;
  const entry = (raw, ratioKey, resetKey) => {
    if (!raw || raw[ratioKey] == null || raw[ratioKey] === '') return null;
    const ratio = Number(raw[ratioKey]);
    return Number.isFinite(ratio) && ratio >= 0
      ? { percent: Math.min(100, ratio * 100), resetAt: typeof raw[resetKey] === 'string' ? raw[resetKey] : null } : null;
  };
  const legacy = detail => {
    const percent = quotaPercentage(detail);
    return percent == null ? null : { percent: Math.max(0, Math.min(100, percent)), resetAt: typeof detail.resetTime === 'string' ? detail.resetTime : null };
  };
  const fiveHour = entry(managed?.limit5h, 'usedRatio', 'resetAt')
    || entry(modern?.limit_5h, 'used_ratio', 'reset_time')
    || legacy(body?.limits?.find?.(item => Number(item?.window?.duration) === 300)?.detail);
  const week = entry(managed?.limit7d, 'usedRatio', 'resetAt')
    || entry(modern?.limit_7d, 'used_ratio', 'reset_time') || legacy(body?.usage);
  return fiveHour || week ? { fiveHour, week } : null;
}

export async function fetchQuota(home, fetchFn = fetch) {
  // 注入 fetch 以离线测试。 / Inject fetch for offline tests.
  let names = [];
  const instances = path.join(home, 'server', 'instances');
  try { names = fs.readdirSync(instances).filter(name => name.endsWith('.json')); } catch { /* CLI-only install */ }
  for (const name of names.slice(0, 8)) {
    try {
      const { port } = JSON.parse(fs.readFileSync(path.join(instances, name), 'utf8'));
      if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
      const response = await fetchFn(`http://127.0.0.1:${port}/api/v1/oauth/usage`, {
        headers: kapAuthHeaders(home), signal: AbortSignal.timeout(1200), redirect: 'error',
      });
      if (!response.ok) continue;
      const quota = normalizeQuota(await response.json());
      if (quota) return { status: 'ok', source: 'local-kimi', quota };
    } catch { /* proceed to the official authenticated endpoint */ }
  }
  let token;
  try { token = JSON.parse(fs.readFileSync(path.join(home, 'credentials', 'kimi-code.json'), 'utf8')).access_token; } catch { /* no login */ }
  if (typeof token !== 'string' || !token) return { status: 'auth_required', quota: null };
  let region = '';
  try { region = fs.readFileSync(path.join(home, 'region'), 'utf8').trim(); } catch { /* mainland default */ }
  const base = (process.env.KIMI_CODE_BASE_URL || (region === 'global' ? 'https://api.kimi.ai/coding/v1' : 'https://api.kimi.com/coding/v1')).replace(/\/+$/, '');
  // 令牌只发授权的官方地址。 / Send tokens only to authorized official origins, without redirects.
  if (!['https://api.kimi.com/coding/v1', 'https://api.kimi.ai/coding/v1'].includes(base)) return { status: 'unsupported_endpoint', quota: null };
  try {
    const response = await fetchFn(`${base}/usages`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000), redirect: 'error',
    });
    if (response.status === 401 || response.status === 403) return { status: 'auth_required', quota: null };
    if (!response.ok) return { status: 'unavailable', quota: null };
    const quota = normalizeQuota(await response.json());
    return { status: quota ? 'ok' : 'no_quota', source: 'official-kimi', quota };
  } catch { return { status: 'offline', quota: null }; }
}

export async function refreshQuota(home) {
  const directory = path.join(home, 'hud', 'kimi-code-monitor');
  const file = path.join(directory, 'quota.json');
  fs.mkdirSync(directory, { recursive: true });
  let previous;
  try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first refresh */ }
  try {
    const result = await fetchQuota(home);
    const now = Date.now();
    const canKeep = ['offline', 'unavailable'].includes(result.status) && previous?.quota && now - previous.fetchedAt < 300000;
    // 断网可用 5 分钟旧值；认证失败清空。 / Retain offline values for 5 minutes; clear on auth failure.
    const state = { schema: 1, ...result, updatedAt: now,
      fetchedAt: result.quota || result.status === 'no_quota' ? now : canKeep ? previous.fetchedAt : null,
      quota: result.quota || (canKeep ? previous.quota : null) };
    const temp = `${file}.${process.pid}.tmp`;
    // 原子替换，避免半份 JSON。 / Replace atomically to avoid partial JSON reads.
    fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(temp, file);
    return state;
  } finally {
    try { fs.unlinkSync(path.join(directory, 'quota-refresh.lock')); } catch { /* manual refresh */ }
  }
}

export async function quotaMain() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--home');
  const home = at >= 0 ? args[at + 1] : process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
  process.env.KIMI_CODE_HOME = home;
  try { console.log(JSON.stringify(await refreshQuota(home))); }
  catch { console.error('Quota cache could not be refreshed.'); process.exitCode = 1; }
}
