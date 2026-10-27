"""Windows 快速入口，仅标准库。 / Fast Windows entry using only the standard library.

用量逻辑移植自 / Usage logic adapted from src/metrics.js (MIT, Copyright (c) 2026 十叶).
网络请求交给独立进程。 / Delegate network requests to a separate worker.
"""
import json
import math
import os
import re
import sys
import unicodedata

MAX_TAIL_BYTES = 512 * 1024
ANSI = re.compile(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]')


def clean(value, limit=80):
    return re.sub(r'[\x00-\x1f\x7f-\x9f\u2028\u2029]', ' ', ANSI.sub('', str(value or ''))).strip()[:limit]


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def js_round(value):
    return math.floor(value + 0.5)


def tokens(value):
    if not finite(value):
        return '--'
    if value >= 1e6:
        return f'{value / 1e6:.1f}m'
    if value >= 1e3:
        # Match JS toFixed for the positive token counts used here.
        return f'{js_round(value / 100) / 10:.1f}'.removesuffix('.0') + 'k'
    return str(math.floor(value))


def cell_width(text):
    width = 0
    for c in ANSI.sub('', text):
        if unicodedata.category(c).startswith('M'):
            continue
        cp = ord(c)
        wide = cp >= 0x1100 and (cp <= 0x115f or 0x2e80 <= cp <= 0xa4cf
            or 0xac00 <= cp <= 0xd7a3 or 0xf900 <= cp <= 0xfaff
            or 0xfe10 <= cp <= 0xfe6f or 0xff01 <= cp <= 0xff60 or cp >= 0x1f300)
        width += 2 if wide else 1
    return width


def shorten(value, width):
    text = clean(value)
    if cell_width(text) <= width:
        return text
    out = ''
    for c in text:
        if cell_width(out + c) > width - 1:
            break
        out += c
    return out + '…'


def terminal_width(maximum=120):
    """管道重定向时仍读取所属终端。 / Query the attached terminal even with redirected stdio."""
    try:
        fd = os.open('CONOUT$' if os.name == 'nt' else '/dev/tty', os.O_RDWR)
        try:
            columns = os.get_terminal_size(fd).columns
        finally:
            os.close(fd)
        return max(20, min(maximum, columns - 2))
    except OSError:
        return maximum


DEFAULT_MODULES = ('status', 'model', 'thinking', 'permission', 'quotaPair', 'cache', 'duration', 'project')
OPTIONAL_MODULES = frozenset(DEFAULT_MODULES + ('quota5h', 'quotaWeek', 'input', 'output', 'speed', 'branch', 'quotaStatus'))
PINNED_MODULES = frozenset(('model', 'status', 'quota5h', 'quotaWeek'))


def module_options(args):
    def names(flag, fallback):
        if flag not in args:
            return list(fallback)
        values = [item.strip() for item in args[args.index(flag) + 1].split(',') if item.strip()]
        if not values or any(item not in OPTIONAL_MODULES for item in values):
            raise ValueError(f'Invalid {flag} module list')
        return values

    modules = names('--modules', DEFAULT_MODULES)
    order = names('--order', modules)
    enabled = set(modules)
    sequence = []
    for name in order + modules:
        if name in enabled and name not in sequence:
            sequence.append(name)
    return sequence


def format_duration(ms):
    if not finite(ms) or ms <= 0:
        return '--'
    if ms < 1000:
        return f'{ms}ms'
    if ms < 60_000:
        return f'{ms / 1000:.1f}'.removesuffix('.0') + 's'
    if ms < 3_600_000:
        return f'{ms / 60_000:.1f}'.removesuffix('.0') + 'm'
    return f'{ms / 3_600_000:.1f}'.removesuffix('.0') + 'h'


def render(payload, activity=None, width=120, color=True, modules=None):
    """状态点和额度优先，其他模块按顺序与空间放入。 / Modular, quota-first layout."""
    p = payload if isinstance(payload, dict) else {}
    a = activity or {}
    sequence = modules or list(DEFAULT_MODULES)
    if not sequence:
        raise ValueError('At least one HUD module is required')
    width = max(20, min(300, int(width)))
    paint = lambda n, s: f'\x1b[{n}m{s}\x1b[0m' if color else s
    sep = '  ' if width < 100 else '    '
    muted = '38;2;139;153;173'
    mode = {'manual': '询问', 'yolo': '按需询问', 'auto': '从不询问'}.get(p.get('permissionMode'), clean(p.get('permissionMode'), 12) or '模式未知')
    mode_text = ('计划·' if p.get('planMode') is True else '') + mode

    def meter(value, size):
        n = max(0, min(100, value)) if finite(value) else None
        units = 0 if n is None else js_round(n / 100 * size * 8)
        filled, fraction = divmod(units, 8)
        tone = '38;2;255;126;145' if n is not None and n >= 90 else '38;2;239;194;111' if n is not None and n >= 75 else '38;2;113;210;166'
        label = '--' if n is None else str(js_round(n))
        # 八分格保留低占用；未知值用阴影占位。 / Eighth cells retain low usage; shade unknown values.
        bar = '█' * filled + ('▏▎▍▌▋▊▉'[fraction - 1] if fraction else '')
        return paint(tone, bar) + paint('38;2;100;117;139', '░' * (size - filled - bool(fraction))) + ' ' + paint(muted, label + '%')

    quota = a.get('quota') or {}
    usage = a.get('usage') or {}
    quota_size = 4 if width >= 80 else 3 if width >= 60 else 2 if width >= 40 else 0
    groups = {}
    status = a.get('status') or 'idle'
    appearance = 'off' if status in ('offline', 'unauthorized') or quota.get('authRequired') else 'warn' if status == 'ratelimit' else 'sub' if status == 'subagent' else 'idle' if status == 'idle' else 'work'
    status_color = {
        'idle': muted,
        'work': '38;2;132;210;255',
        'off': '38;2;255;126;145',
        'warn': '38;2;239;194;111',
        'sub': '38;2;113;210;166',
    }[appearance]
    groups['status'] = paint(status_color, '●')
    for name, key, label in [('quota5h', 'fiveHour', '5h'), ('quotaWeek', 'week', '周')]:
        value = (quota.get(key) or {}).get('percent')
        groups[name] = paint(muted, label + ' ') + meter(value, quota_size)
    five_hour = (quota.get('fiveHour') or {}).get('percent')
    week = (quota.get('week') or {}).get('percent')
    groups['quotaPair'] = (paint(muted, '5h/7d ') if width >= 40 else '') + meter(five_hour, quota_size) + ' ' + meter(week, quota_size)
    cache_pct = math.floor(usage['cacheRead'] / usage['input'] * 100) if usage.get('input', 0) > 0 else None
    groups['cache'] = paint(muted, '缓存 ' + (str(cache_pct) if cache_pct is not None else '--') + '%')
    groups['duration'] = paint(muted, '上轮' + format_duration(a.get('durationMs')))
    groups['model'] = paint('1;' + status_color, shorten(p.get('model') or 'Kimi', max(4, min(26, width // 5))))
    effort = clean(p.get('thinkingEffort') or a.get('thinkingEffort'), 12) or '--'
    groups['thinking'] = paint(muted, '思考 ' + effort)
    groups['permission'] = paint('38;2;239;194;111' if p.get('permissionMode') == 'auto' else muted, mode_text)
    project = re.split(r'[\\/]', clean(p.get('cwd'), 2048).rstrip('/\\'))[-1]
    groups['project'] = paint(muted, shorten(project, 22)) if project else ''
    groups['input'] = paint(muted, '输入 ' + tokens(usage.get('input')))
    groups['output'] = paint(muted, '输出 ' + tokens(usage.get('output')))
    groups['speed'] = paint('38;2;132;210;255', f"{a['speed']:.1f} tok/s" if finite(a.get('speed')) else '-- tok/s')
    branch = clean(p.get('gitBranch')).split('/')[-1]
    groups['branch'] = paint('38;2;178;155;218', shorten(branch, 20)) if branch else ''
    has_quota = any(finite((quota.get(key) or {}).get('percent')) for key in ('fiveHour', 'week'))
    quota_status = '需登录' if quota.get('authRequired') else '' if has_quota else '暂无' if width < 100 else '额度暂无'
    groups['quotaStatus'] = paint('38;2;239;194;111' if quota.get('authRequired') else muted, quota_status + (' ~' if quota.get('stale') else ''))

    def join_groups(parts):
        text = ''
        previous_group = ''
        for name, value in parts:
            group = 'identity' if name in ('status', 'model', 'thinking', 'permission') else 'activity' if name in ('cache', 'duration') else name
            text += (' ' if group == previous_group else '    ') + value if text else value
            previous_group = group
        return text

    parts = [(name, groups[name]) for name in sequence if name in PINNED_MODULES and groups.get(name)]
    pair_index = sequence.index('quotaPair') if 'quotaPair' in sequence else -1
    for index, name in enumerate(sequence):
        if name in PINNED_MODULES or not groups.get(name):
            continue
        value = groups[name]
        candidate = parts + [(name, value)]
        if pair_index > index:
            candidate.append(('quotaPair', groups['quotaPair']))
        if cell_width(join_groups(candidate)) <= width:
            parts.append((name, value))
    return join_groups(parts)


def usage_bucket(raw):
    """输入包含两类缓存。 / Total input includes ordinary, cache-read and cache-write tokens."""
    raw = raw if isinstance(raw, dict) else {}

    def number(keys):
        for key in keys:
            if raw.get(key) is not None:
                try:
                    n = float(raw[key])
                    return math.floor(n) if finite(n) else 0
                except (TypeError, ValueError, OverflowError):
                    return 0
        return 0

    other = number(['inputOther', 'input_tokens', 'prompt_tokens', 'inputTokens'])
    output = number(['output', 'output_tokens', 'completion_tokens', 'outputTokens'])
    cache = number(['inputCacheRead', 'cache_read_input_tokens', 'cache_read_tokens', 'cacheReadTokens'])
    creation = number(['inputCacheCreation', 'cache_creation_input_tokens', 'cache_creation_tokens', 'cacheCreationTokens'])
    return {'input': other + cache + creation, 'output': output, 'cacheRead': cache}


def parse_activity(text):
    """还原尾部状态与末次用量。 / Fold tail status and latest usage without retaining message bodies."""
    result, active, interactions = {}, {}, set()
    turn_active = False

    def work_status(status):
        return 'executing' if active else status

    for line in text.splitlines():
        if not re.search(r'"(?:turn\.(?:prompt|started|ended|completed)|usage\.record|profile\.bind|config\.update|llm\.request|context\.append_loop_event|interaction\.(?:request|resolved)|subagent\.(?:spawned|started|suspended|completed|failed)|error|event\.session\.work_changed|agent\.status\.updated)"', line):
            continue
        try:
            r = json.loads(line)
        except (ValueError, TypeError):
            continue
        if not isinstance(r, dict):
            continue
        kind = r.get('type')
        payload = r.get('payload') if isinstance(r.get('payload'), dict) else r
        if kind in ('subagent.spawned', 'subagent.started', 'subagent.suspended'):
            result['status'] = work_status('subagent')
            continue
        if kind in ('subagent.completed', 'subagent.failed'):
            result['status'] = work_status('thinking')
            continue
        if kind == 'error':
            if payload.get('code') == 'provider.rate_limit':
                result['status'] = 'ratelimit'
            continue
        if r.get('agentId', 'main') != 'main':
            continue
        if kind in ('profile.bind', 'config.update', 'llm.request'):
            if isinstance(r.get('thinkingEffort'), str):
                result['thinkingEffort'] = r['thinkingEffort']
        elif kind in ('turn.prompt', 'turn.started'):
            turn_active = True
            active.clear()
            interactions.clear()
            result['status'] = 'thinking'
            result.pop('speed', None)
        elif kind in ('turn.ended', 'turn.completed'):
            turn_active = False
            active.clear()
            interactions.clear()
            result['status'] = 'idle'
            duration = r.get('durationMs', r.get('duration_ms', r.get('duration')))
            if finite(duration) and duration > 0:
                result['durationMs'] = duration
        elif kind == 'interaction.request':
            interactions.add(r.get('id'))
            result['status'] = work_status('idle')
        elif kind == 'interaction.resolved':
            interactions.discard(r.get('id'))
            if not interactions:
                result['status'] = work_status('thinking' if turn_active else 'idle')
        elif kind == 'event.session.work_changed':
            busy = bool(payload.get('busy') or payload.get('main_turn_active'))
            if not busy or turn_active:
                result['status'] = work_status('thinking' if busy else 'idle')
        elif kind == 'agent.status.updated':
            agent_status = payload.get('status') or payload.get('agent_status')
            if agent_status in ('idle', 'waiting'):
                result['status'] = work_status('idle')
            elif turn_active and agent_status in ('thinking', 'processing', 'running', 'working'):
                result['status'] = work_status('thinking')
        elif kind == 'usage.record' and isinstance(r.get('usage'), dict):
            result['usage'] = usage_bucket(r['usage'])
        elif kind == 'context.append_loop_event' and isinstance(r.get('event'), dict):
            e = r['event']
            if e.get('type') == 'tool.call':
                turn_active = True
                active[e.get('toolCallId')] = clean(e.get('name'), 24)
                result['status'] = 'executing'
            elif e.get('type') == 'tool.result':
                active.pop(e.get('toolCallId'), None)
                result['status'] = work_status('idle' if interactions else 'thinking' if turn_active else 'idle')
            elif e.get('type') == 'step.begin':
                turn_active = True
                if not active:
                    result['status'] = 'thinking'
                result.pop('speed', None)
            elif e.get('type') == 'step.end':
                turn_active = True
                if not active:
                    result['status'] = 'thinking'
                duration = e.get('llmStreamDurationMs')
                output = usage_bucket(e.get('usage'))['output']
                if finite(duration) and duration >= 100 and output > 0:
                    result['speed'] = output / (duration / 1000)
            if interactions:
                result['status'] = work_status('idle')
    return result


def read_activity(home, session):
    """只读当前会话 512 KiB 尾部。 / Read only the selected session's last 512 KiB."""
    if not isinstance(session, str) or not re.fullmatch(r'session_[a-zA-Z0-9_-]+', session):
        return {}
    root = os.path.join(home, 'sessions')
    try:
        with os.scandir(root) as workspaces:
            for workspace in workspaces:
                if not workspace.is_dir(follow_symlinks=False):
                    continue
                wire = os.path.join(workspace.path, session, 'agents', 'main', 'wire.jsonl')
                try:
                    with open(wire, 'rb') as f:
                        start = max(0, os.fstat(f.fileno()).st_size - MAX_TAIL_BYTES)
                        f.seek(start)
                        text = f.read(MAX_TAIL_BYTES).decode('utf-8', errors='replace')
                    if start:
                        text = text[text.find('\n') + 1:]
                    return parse_activity(text[:text.rfind('\n') + 1])
                except (OSError, TypeError, ValueError, KeyError, OverflowError):
                    continue
    except OSError:
        pass
    return {}


def read_quota(home):
    """读缓存，异步刷新旧值。 / Read cached quota and refresh stale values in a hidden worker."""
    import time
    now = time.time() * 1000
    directory = os.path.join(home, 'hud', 'kimi-code-monitor')
    state = {}
    try:
        with open(os.path.join(directory, 'quota.json'), encoding='utf-8') as f:
            state = json.load(f)
    except (OSError, ValueError):
        pass
    if os.environ.get('KIMI_CODE_STATUS_LINE') == '1' and now - state.get('updatedAt', 0) > 60000:
        lock = os.path.join(directory, 'quota-refresh.lock')
        acquired = False
        try:
            with open(os.path.join(os.path.dirname(__file__), 'quota-worker.json'), encoding='utf-8') as f:
                worker = json.load(f)
            os.makedirs(directory, exist_ok=True)
            try:
                if now - os.stat(lock).st_mtime * 1000 > 30000:
                    os.unlink(lock)
            except OSError:
                pass
            with open(lock, 'x') as f:
                f.write(str(now))
            acquired = True
            import subprocess
            # 隐藏窗口并独立进程组。 / CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP on Windows.
            subprocess.Popen([worker['node'], worker['script'], '--home', home],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=0x08000200 if os.name == 'nt' else 0,
                start_new_session=os.name != 'nt')
        except (OSError, ValueError, KeyError):
            if acquired:
                try:
                    os.unlink(lock)
                except OSError:
                    pass
    if state.get('status') == 'no_quota' and now - state.get('updatedAt', 0) < 300000:
        return {'empty': True}
    if state.get('status') == 'auth_required' and now - state.get('updatedAt', 0) < 300000:
        return {'authRequired': True}
    fetched = state.get('fetchedAt')
    if not state.get('quota') or not finite(fetched) or now - fetched > 300000:
        return None
    return {**state['quota'], 'stale': state.get('status') != 'ok' or now - fetched > 90000}


def main():
    args = sys.argv[1:]
    width = int(args[args.index('--width') + 1]) if '--width' in args else int(os.environ.get('COLUMNS') or 120)
    width = terminal_width(width)
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    payload = json.loads(sys.stdin.buffer.read().decode('utf-8-sig'))
    if not isinstance(payload, dict):
        raise ValueError('Expected object')
    home = os.environ.get('KIMI_CODE_HOME') or os.path.join(os.path.expanduser('~'), '.kimi-code')
    activity = {} if '--no-wire' in args else read_activity(home, payload.get('sessionId'))
    if '--no-quota' not in args:
        activity['quota'] = read_quota(home)
    color_option = args[args.index('--color') + 1] if '--color' in args else 'auto'
    color = '--plain' not in args and (color_option == 'always' or 'NO_COLOR' not in os.environ)
    print(render(payload, activity, width, color, module_options(args)))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, TypeError, OSError, KeyError, OverflowError):
        sys.exit(1)
