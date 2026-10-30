import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tty from 'node:tty';
import { spawn } from 'node:child_process';

const MAX_TAIL_BYTES = 512 * 1024;
const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g;
const CONTROLS = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/g;
const DEFAULT_MODULES = ['status', 'model', 'thinking', 'permission', 'quotaPair', 'speed', 'cache', 'input', 'output', 'project'];
const OPTIONAL_MODULES = new Set([...DEFAULT_MODULES, 'quota5h', 'quotaWeek', 'duration', 'branch', 'quotaStatus']);
const PINNED_MODULES = new Set(['model', 'status', 'quota5h', 'quotaWeek']);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const jsRound = value => Math.floor(value + 0.5);
const get = (object, key, fallback = undefined) => Object.hasOwn(object, key) ? object[key] : fallback;

export function clean(value, limit = 80) {
  const text = String(value || '').replace(ANSI, '').replace(CONTROLS, ' ').trim();
  return Array.from(text).slice(0, limit).join('');
}

function pythonFixed1(value) {
  const scaled = value * 10;
  const lower = Math.floor(scaled);
  if (Number.isInteger(value * 4) && scaled - lower === 0.5) return ((lower % 2 === 0 ? lower : lower + 1) / 10).toFixed(1);
  return value.toFixed(1);
}

export function tokens(value) {
  if (!finite(value)) return '--';
  if (value >= 1e6) return `${pythonFixed1(value / 1e6)}m`;
  if (value >= 1e3) return `${(jsRound(value / 100) / 10).toFixed(1).replace(/\.0$/, '')}k`;
  return String(Math.floor(value));
}

export function cellWidth(text) {
  let width = 0;
  for (const character of String(text).replace(ANSI, '')) {
    if (/\p{M}/u.test(character)) continue;
    const cp = character.codePointAt(0);
    const wide = cp >= 0x1100 && (cp <= 0x115f || cp >= 0x2e80 && cp <= 0xa4cf
      || cp >= 0xac00 && cp <= 0xd7a3 || cp >= 0xf900 && cp <= 0xfaff
      || cp >= 0xfe10 && cp <= 0xfe6f || cp >= 0xff01 && cp <= 0xff60 || cp >= 0x1f300);
    width += wide ? 2 : 1;
  }
  return width;
}

export function shorten(value, width) {
  const text = clean(value);
  if (cellWidth(text) <= width) return text;
  let output = '';
  for (const character of text) {
    if (cellWidth(output + character) > width - 1) break;
    output += character;
  }
  return `${output}…`;
}

export function terminalWidth(maximum = 120) {
  let fd;
  let stream;
  try {
    fd = fs.openSync(process.platform === 'win32' ? 'CONOUT$' : '/dev/tty', 'r+');
    stream = new tty.WriteStream(fd);
    const columns = stream.columns;
    return Math.max(20, Math.min(maximum, columns - 2));
  } catch {
    return maximum;
  } finally {
    if (stream) stream.destroy();
    else if (fd !== undefined) fs.closeSync(fd);
  }
}

export function moduleOptions(args) {
  const names = (flag, fallback) => {
    if (!args.includes(flag)) return [...fallback];
    const values = args[args.indexOf(flag) + 1].split(',').map(item => item.trim()).filter(Boolean);
    if (!values.length || values.some(item => !OPTIONAL_MODULES.has(item))) throw new Error(`Invalid ${flag} module list`);
    return values;
  };
  const modules = names('--modules', DEFAULT_MODULES);
  const order = names('--order', modules);
  const enabled = new Set(modules);
  const sequence = [];
  for (const name of [...order, ...modules]) if (enabled.has(name) && !sequence.includes(name)) sequence.push(name);
  return sequence;
}

export function formatDuration(ms) {
  if (!finite(ms) || ms <= 0) return '--';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${pythonFixed1(ms / 1000).replace(/\.0$/, '')}s`;
  if (ms < 3600000) return `${pythonFixed1(ms / 60000).replace(/\.0$/, '')}m`;
  return `${pythonFixed1(ms / 3600000).replace(/\.0$/, '')}h`;
}

export function render(payload, activity = null, width = 120, color = true, modules = null) {
  const p = isRecord(payload) ? payload : {};
  const a = activity || {};
  const sequence = modules?.length ? modules : DEFAULT_MODULES;
  if (!sequence.length) throw new Error('At least one HUD module is required');
  width = Math.max(20, Math.min(300, Math.trunc(width)));
  const paint = (code, text) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const muted = '38;2;139;153;173';
  const fallbackMode = clean(p.permissionMode, 12) || '模式未知';
  const mode = ({ manual: '询问', yolo: '按需询问', auto: '从不询问' })[p.permissionMode] ?? fallbackMode;
  const modeText = `${p.planMode === true ? '计划·' : ''}${mode}`;

  const meter = (value, size, percentFirst = false) => {
    const n = finite(value) ? Math.max(0, Math.min(100, value)) : null;
    const units = n === null ? 0 : jsRound(n / 100 * size * 8);
    const filled = Math.floor(units / 8);
    const fraction = units % 8;
    const tone = n !== null && n >= 90 ? '38;2;255;126;145' : n !== null && n >= 75 ? '38;2;239;194;111' : '38;2;113;210;166';
    const label = n === null ? '--' : String(jsRound(n));
    const bar = '█'.repeat(filled) + (fraction ? '▏▎▍▌▋▊▉'[fraction - 1] : '');
    const barText = paint(tone, bar) + paint('38;2;100;117;139', '░'.repeat(size - filled - Number(Boolean(fraction))));
    const percentText = paint(n === null ? muted : tone, `${label}%`);
    return percentFirst ? `${percentText} ${barText}` : `${barText} ${percentText}`;
  };

  const quota = a.quota || {};
  const usage = a.usage || {};
  const quotaSize = width >= 80 ? 4 : width >= 60 ? 3 : width >= 40 ? 2 : 0;
  const groups = {};
  const status = a.status || 'idle';
  const appearance = ['offline', 'unauthorized'].includes(status) || quota.authRequired ? 'off'
    : status === 'ratelimit' ? 'warn' : status === 'subagent' ? 'sub' : status === 'idle' ? 'idle' : 'work';
  const statusColor = {
    idle: muted,
    work: '38;2;132;210;255',
    off: '38;2;255;126;145',
    warn: '38;2;239;194;111',
    sub: '38;2;113;210;166',
  }[appearance];
  groups.status = paint(statusColor, '●');
  for (const [name, key, label] of [['quota5h', 'fiveHour', '5h'], ['quotaWeek', 'week', '周']]) {
    groups[name] = paint(muted, `${label} `) + meter(quota[key]?.percent, quotaSize);
  }
  groups.quotaPair = `${width >= 40 ? paint(muted, '5h ') : ''}${meter(quota.fiveHour?.percent, quotaSize, true)} ${width >= 40 ? paint(muted, '7d ') : ''}${meter(quota.week?.percent, quotaSize, true)}`;
  const cachePercent = (get(usage, 'input', 0) > 0) ? Math.floor(usage.cacheRead / usage.input * 100) : null;
  groups.cache = paint(muted, `缓存 ${cachePercent === null ? '--' : cachePercent}%`);
  groups.duration = paint(muted, `上轮${formatDuration(a.durationMs)}`);
  groups.model = paint(`1;${statusColor}`, shorten(p.model || 'Kimi', Math.max(4, Math.min(26, Math.floor(width / 5)))));
  const effort = clean(p.thinkingEffort || a.thinkingEffort, 12) || '--';
  groups.thinking = paint(muted, `思考 ${effort}`);
  groups.permission = paint(p.permissionMode === 'auto' ? '38;2;239;194;111' : muted, modeText);
  const project = clean(p.cwd, 2048).replace(/[\\/]+$/, '').split(/[\\/]/).at(-1);
  groups.project = project ? paint(muted, shorten(project, 22)) : '';
  groups.input = paint(muted, `输入 ${tokens(usage.input)}`);
  groups.output = paint(muted, `输出 ${tokens(usage.output)}`);
  groups.speed = paint(muted, finite(a.speed) ? `${pythonFixed1(a.speed)}tok/s` : '--tok/s');
  const branch = clean(p.gitBranch).split('/').at(-1);
  groups.branch = branch ? paint('38;2;178;155;218', shorten(branch, 20)) : '';
  const hasQuota = ['fiveHour', 'week'].some(key => finite(quota[key]?.percent));
  const quotaStatus = quota.authRequired ? '需登录' : hasQuota ? '' : width < 100 ? '暂无' : '额度暂无';
  groups.quotaStatus = paint(quota.authRequired ? '38;2;239;194;111' : muted, quotaStatus + (quota.stale ? ' ~' : ''));

  const joinGroups = parts => {
    let text = '';
    let previousGroup = '';
    for (const [name, value] of parts) {
      const group = ['status', 'model', 'thinking', 'permission'].includes(name) ? 'identity'
        : ['cache', 'duration', 'speed'].includes(name) ? 'activity'
        : ['input', 'output'].includes(name) ? 'tokens' : name;
      text += text ? `${group === previousGroup ? ' ' : '    '}${value}` : value;
      previousGroup = group;
    }
    return text;
  };

  const parts = sequence.filter(name => PINNED_MODULES.has(name) && groups[name]).map(name => [name, groups[name]]);
  const pairIndex = sequence.indexOf('quotaPair');
  for (const [index, name] of sequence.entries()) {
    if (PINNED_MODULES.has(name) || !groups[name]) continue;
    const candidate = [...parts, [name, groups[name]]];
    if (pairIndex > index) candidate.push(['quotaPair', groups.quotaPair]);
    if (cellWidth(joinGroups(candidate)) <= width) parts.push([name, groups[name]]);
  }
  return joinGroups(parts);
}

export function usageBucket(raw) {
  raw = isRecord(raw) ? raw : {};
  const number = keys => {
    for (const key of keys) {
      if (get(raw, key) !== null && get(raw, key) !== undefined) {
        const n = Number(raw[key]);
        return finite(n) ? Math.floor(n) : 0;
      }
    }
    return 0;
  };
  const other = number(['inputOther', 'input_tokens', 'prompt_tokens', 'inputTokens']);
  const output = number(['output', 'output_tokens', 'completion_tokens', 'outputTokens']);
  const cache = number(['inputCacheRead', 'cache_read_input_tokens', 'cache_read_tokens', 'cacheReadTokens']);
  const creation = number(['inputCacheCreation', 'cache_creation_input_tokens', 'cache_creation_tokens', 'cacheCreationTokens']);
  return { input: other + cache + creation, output, cacheRead: cache };
}

const ACTIVITY_RECORD = /"(?:turn\.(?:prompt|started|ended|completed)|usage\.record|profile\.bind|config\.update|llm\.request|context\.append_loop_event|interaction\.(?:request|resolved)|subagent\.(?:spawned|started|suspended|completed|failed)|error|event\.session\.work_changed|agent\.status\.updated)"/;

export function parseActivity(text) {
  const result = {};
  const active = new Map();
  const interactions = new Set();
  let turnActive = false;
  const workStatus = status => active.size ? 'executing' : status;

  for (const line of text.split(/\r?\n/)) {
    if (!ACTIVITY_RECORD.test(line)) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!isRecord(r)) continue;
    const kind = r.type;
    const payload = isRecord(r.payload) ? r.payload : r;
    if (['subagent.spawned', 'subagent.started', 'subagent.suspended'].includes(kind)) {
      result.status = workStatus('subagent');
      continue;
    }
    if (['subagent.completed', 'subagent.failed'].includes(kind)) {
      result.status = workStatus('thinking');
      continue;
    }
    if (kind === 'error') {
      if (payload.code === 'provider.rate_limit') result.status = 'ratelimit';
      continue;
    }
    if (get(r, 'agentId', 'main') !== 'main') continue;
    if (['profile.bind', 'config.update', 'llm.request'].includes(kind)) {
      if (typeof r.thinkingEffort === 'string') result.thinkingEffort = r.thinkingEffort;
    } else if (['turn.prompt', 'turn.started'].includes(kind)) {
      turnActive = true;
      active.clear();
      interactions.clear();
      result.status = 'thinking';
      delete result.speed;
    } else if (['turn.ended', 'turn.completed'].includes(kind)) {
      turnActive = false;
      active.clear();
      interactions.clear();
      result.status = 'idle';
      const duration = get(r, 'durationMs', get(r, 'duration_ms', get(r, 'duration')));
      if (finite(duration) && duration > 0) result.durationMs = duration;
    } else if (kind === 'interaction.request') {
      interactions.add(r.id);
      result.status = workStatus('idle');
    } else if (kind === 'interaction.resolved') {
      interactions.delete(r.id);
      if (!interactions.size) result.status = workStatus(turnActive ? 'thinking' : 'idle');
    } else if (kind === 'event.session.work_changed') {
      const busy = Boolean(payload.busy || payload.main_turn_active);
      if (!busy || turnActive) result.status = workStatus(busy ? 'thinking' : 'idle');
    } else if (kind === 'agent.status.updated') {
      const agentStatus = payload.status || payload.agent_status;
      if (['idle', 'waiting'].includes(agentStatus)) result.status = workStatus('idle');
      else if (turnActive && ['thinking', 'processing', 'running', 'working'].includes(agentStatus)) result.status = workStatus('thinking');
    } else if (kind === 'usage.record' && isRecord(r.usage)) {
      result.usage = usageBucket(r.usage);
    } else if (kind === 'context.append_loop_event' && isRecord(r.event)) {
      const event = r.event;
      if (event.type === 'tool.call') {
        turnActive = true;
        active.set(event.toolCallId, clean(event.name, 24));
        result.status = 'executing';
      } else if (event.type === 'tool.result') {
        active.delete(event.toolCallId);
        result.status = workStatus(interactions.size ? 'idle' : turnActive ? 'thinking' : 'idle');
      } else if (event.type === 'step.begin') {
        turnActive = true;
        if (!active.size) result.status = 'thinking';
        delete result.speed;
      } else if (event.type === 'step.end') {
        turnActive = true;
        if (!active.size) result.status = 'thinking';
        const duration = event.llmStreamDurationMs;
        const output = usageBucket(event.usage).output;
        if (finite(duration) && duration >= 100 && output > 0) result.speed = output / (duration / 1000);
      }
      if (interactions.size) result.status = workStatus('idle');
    }
  }
  return result;
}

export function readActivity(home, session) {
  if (typeof session !== 'string' || !/^session_[a-zA-Z0-9_-]+$/.test(session)) return {};
  const root = path.join(home, 'sessions');
  let workspaces;
  try { workspaces = fs.readdirSync(root, { withFileTypes: true }); } catch { return {}; }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const wire = path.join(root, workspace.name, session, 'agents', 'main', 'wire.jsonl');
    let fd;
    try {
      fd = fs.openSync(wire, 'r');
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - MAX_TAIL_BYTES);
      const buffer = Buffer.alloc(Math.min(MAX_TAIL_BYTES, size));
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, start);
      let text = buffer.subarray(0, bytes).toString('utf8');
      if (start) text = text.slice(text.indexOf('\n') + 1);
      return parseActivity(text.slice(0, text.lastIndexOf('\n') + 1));
    } catch {
      continue;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  return {};
}

export function readQuota(home) {
  const now = Date.now();
  const directory = path.join(home, 'hud', 'kimi-code-monitor');
  let state = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(directory, 'quota.json'), 'utf8'));
    if (isRecord(parsed)) state = parsed;
  } catch {}
  if (process.env.KIMI_CODE_STATUS_LINE === '1' && now - get(state, 'updatedAt', 0) > 60000) {
    const lock = path.join(directory, 'quota-refresh.lock');
    let acquired = false;
    try {
      const script = typeof __filename === 'string' ? __filename : process.argv[1];
      const worker = JSON.parse(fs.readFileSync(path.join(path.dirname(path.resolve(script)), 'quota-worker.json'), 'utf8'));
      fs.mkdirSync(directory, { recursive: true });
      try {
        if (now - fs.statSync(lock).mtimeMs > 30000) fs.unlinkSync(lock);
      } catch {}
      fs.writeFileSync(lock, String(now), { flag: 'wx' });
      acquired = true;
      const child = spawn(worker.node, [worker.script, '--home', home], {
        stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32',
      });
      child.on('error', () => {});
      child.unref();
    } catch {
      if (acquired) {
        try { fs.unlinkSync(lock); } catch {}
      }
    }
  }
  if (state.status === 'no_quota' && now - get(state, 'updatedAt', 0) < 300000) return { empty: true };
  if (state.status === 'auth_required' && now - get(state, 'updatedAt', 0) < 300000) return { authRequired: true };
  const fetched = state.fetchedAt;
  if (!state.quota || !finite(fetched) || now - fetched > 300000) return null;
  return { ...state.quota, stale: state.status !== 'ok' || now - fetched > 90000 };
}

function integerOption(value) {
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error('Expected integer');
  return number;
}

export function main() {
  const args = process.argv[1]?.startsWith('--') ? process.argv.slice(1) : process.argv.slice(2);
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const configuredWidth = integerOption(option('--width', process.env.COLUMNS || 120));
  const width = terminalWidth(configuredWidth);
  const input = fs.readFileSync(0).toString('utf8').replace(/^\uFEFF/, '');
  const payload = JSON.parse(input);
  if (!isRecord(payload)) throw new Error('Expected object');
  const home = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
  const activity = args.includes('--no-wire') ? {} : readActivity(home, payload.sessionId);
  if (!args.includes('--no-quota')) activity.quota = readQuota(home);
  const colorOption = option('--color', 'auto');
  const color = !args.includes('--plain') && (colorOption === 'always' || !Object.hasOwn(process.env, 'NO_COLOR'));
  process.stdout.write(`${render(payload, activity, width, color, moduleOptions(args))}\n`);
}
