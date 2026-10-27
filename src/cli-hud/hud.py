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


def render(payload, activity=None, width=120, color=True, details=False):
    """按优先级放入整组信息。 / Fit whole groups by priority; hide detailed metrics by default."""
    p = payload if isinstance(payload, dict) else {}
    a = activity or {}
    width = max(20, min(300, int(width)))
    paint = lambda n, s: f'\x1b[{n}m{s}\x1b[0m' if color else s
    sep = '  ' if width < 100 else '    '
    muted = '38;2;139;153;173'
    mode = {'manual': '询问', 'yolo': '按需询问', 'auto': '从不询问'}.get(p.get('permissionMode'), clean(p.get('permissionMode'), 12) or '模式未知')
    mode_text = ('计划·' if p.get('planMode') is True else '') + mode
    pct = None
    if finite(p.get('contextTokens')) and finite(p.get('maxContextTokens')) and p['maxContextTokens'] > 0:
        pct = min(100, p['contextTokens'] / p['maxContextTokens'] * 100)
    elif finite(p.get('contextUsage')):
        pct = min(100, p['contextUsage'] * 100)

    def meter(value, size):
        n = max(0, min(100, value)) if finite(value) else None
        units = 0 if n is None else js_round(n / 100 * size * 8)
        filled, fraction = divmod(units, 8)
        tone = '38;2;255;126;145' if n is not None and n >= 90 else '38;2;239;194;111' if n is not None and n >= 75 else '38;2;113;210;166'
        label = '--' if n is None else str(js_round(n))
        # 八分格保留低占用；未知值用阴影占位。 / Eighth cells retain low usage; shade unknown values.
        bar = '█' * filled + ('▏▎▍▌▋▊▉'[fraction - 1] if fraction else '')
        return paint(tone, bar) + paint('38;2;100;117;139', '░' * (size - filled - bool(fraction))) + ' ' + paint(muted, label + '%')

    context = paint(muted, 'Ctx ') + meter(pct, 4 if width < 60 else 6 if width < 100 else 10)
    quota = a.get('quota') or {}
    items = []
    for key, label in [('fiveHour', '5h'), ('week', '周')]:
        value = (quota.get(key) or {}).get('percent')
        if finite(value):
            items.append(paint(muted, label + ' ') + meter(value, 3 if width < 80 else 4))
            if width < 60:
                break
    quota_text = paint(muted, 'Kimi ') + ('  '.join(items) + (paint(muted, ' ~') if quota.get('stale') else '') if items else
        meter(None, 3 if width < 80 else 4) + ' ' + paint('38;2;239;194;111' if quota.get('authRequired') else muted, '需登录' if quota.get('authRequired') else '暂无' if width < 100 else '额度暂无'))
    if width < 60:
        quota_text = paint(muted, 'Kimi ') + (meter((quota.get('fiveHour') or quota.get('week') or {}).get('percent'), 3))
    if cell_width(context) + len(sep) + cell_width(quota_text) > width:
        return paint(muted, 'Ctx ') + meter(pct, 4)
    # 先为右侧额度留位，再填中间信息。 / Reserve the right quota before fitting middle groups.
    left_width = width - cell_width(quota_text) - len(sep)
    parts = [context]

    def add(value):
        if cell_width(value) == 0:
            return
        if cell_width(sep.join(parts + [value])) <= left_width:
            parts.append(value)

    effort = clean(p.get('thinkingEffort') or a.get('thinkingEffort'), 12) or '--'
    thinking = paint(muted, '思考 ' + effort)
    model_width = min(26, left_width - cell_width(context) - cell_width(thinking) - len(sep) * 2)
    if model_width >= 6:
        add(paint('1;38;2;132;210;255', shorten(p.get('model') or 'Kimi', model_width)))
    add(thinking)
    permission = paint('38;2;239;194;111' if p.get('permissionMode') == 'auto' else muted, mode_text)
    if a.get('status'):
        status_color = '38;2;113;210;166' if a['status'] == '已完成' else '38;2;239;194;111' if a['status'] in ('等待确认', '等待处理') else '38;2;255;126;145' if a['status'] == '出错' else '38;2;132;210;255'
        status = paint(status_color, '● ' + shorten(a['status'], 18))
        if cell_width(sep.join(parts + [status, permission])) <= left_width:
            add(status)
    add(permission)
    project = re.split(r'[\\/]', clean(p.get('cwd'), 2048).rstrip('/\\'))[-1]
    if project:
        add(paint(muted, shorten(project, 22)))
    branch = clean(p.get('gitBranch')).split('/')[-1]
    if branch:
        add(paint('38;2;178;155;218', shorten(branch, 20)))
    if details and a.get('usage'):
        usage = a['usage']
        add(paint(muted, f"末次 ↑{tokens(usage['input'])} ↓{tokens(usage['output'])}"))
        if usage['input'] > 0:
            add(paint(muted, f"缓存 {math.floor(usage['cacheRead'] / usage['input'] * 100)}%"))
    if details and finite(a.get('speed')):
        add(paint('38;2;132;210;255', f"{a['speed']:.1f} tok/s"))
    left = sep.join(parts)
    return left + ' ' * max(2, width - cell_width(left) - cell_width(quota_text)) + quota_text


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
    for line in text.splitlines():
        if not re.search(r'"(?:turn\.prompt|turn\.ended|usage\.record|profile\.bind|config\.update|llm\.request|context\.append_loop_event|interaction\.(?:request|resolved))"', line):
            continue
        try:
            r = json.loads(line)
        except (ValueError, TypeError):
            continue
        if not isinstance(r, dict) or r.get('agentId', 'main') != 'main':
            continue
        kind = r.get('type')
        if kind in ('profile.bind', 'config.update', 'llm.request'):
            if isinstance(r.get('thinkingEffort'), str):
                result['thinkingEffort'] = r['thinkingEffort']
        elif kind == 'turn.prompt':
            active.clear()
            interactions.clear()
            result['status'] = '生成中'
            result.pop('speed', None)
        elif kind == 'turn.ended':
            active.clear()
            interactions.clear()
            result['status'] = {'completed': '已完成', 'cancelled': '已停止', 'failed': '出错', 'blocked': '等待处理'}.get(r.get('reason'), '已结束')
        elif kind == 'interaction.request':
            interactions.add(r.get('id'))
            result['status'] = '等待确认'
        elif kind == 'interaction.resolved':
            interactions.discard(r.get('id'))
            if not interactions:
                result['status'] = '执行 ' + next(iter(active.values())) if active else '生成中'
        elif kind == 'usage.record' and isinstance(r.get('usage'), dict):
            result['usage'] = usage_bucket(r['usage'])
        elif kind == 'context.append_loop_event' and isinstance(r.get('event'), dict):
            e = r['event']
            if e.get('type') == 'tool.call':
                active[e.get('toolCallId')] = clean(e.get('name'), 24)
                result['status'] = '执行 ' + clean(e.get('name'), 24)
            elif e.get('type') == 'tool.result':
                active.pop(e.get('toolCallId'), None)
                result['status'] = '执行 ' + next(iter(active.values())) if active else '生成中'
            elif e.get('type') == 'step.begin':
                if not active:
                    result['status'] = '生成中'
                result.pop('speed', None)
            elif e.get('type') == 'step.end':
                duration = e.get('llmStreamDurationMs')
                output = usage_bucket(e.get('usage'))['output']
                if finite(duration) and duration >= 100 and output > 0:
                    result['speed'] = output / (duration / 1000)
            if interactions:
                result['status'] = '等待确认'
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
    print(render(payload, activity, width, color, '--details' in args))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, TypeError, OSError, KeyError, OverflowError):
        sys.exit(1)
