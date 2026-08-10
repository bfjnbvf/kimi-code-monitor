const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const shared = require('../session-rename/rename-shared.js');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const buildSh = fs.readFileSync(path.join(root, 'build.sh'), 'utf8');
const backgroundSource = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const contentSource = fs.readFileSync(path.join(root, 'content.js'), 'utf8');

function userMessage(text) {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function assistantMessage(text) {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

test('取样：thinking/tool_use/tool_result 与 role=tool 一律丢弃，只留 user/assistant 的 text', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'thinking', thinking: '内部推理' }] },
    { role: 'assistant', content: [{ type: 'tool_use', name: 'bash', input: 'ls' }] },
    { role: 'tool', content: [{ type: 'tool_result', text: '不该出现' }] },
    userMessage('修一下登录按钮'),
    assistantMessage('好的，我先看样式'),
    { role: 'assistant', content: [{ type: 'text', text: '补充说明' }, { type: 'tool_use', name: 'x' }] }
  ];
  const context = shared.buildRenameContext(messages);
  assert.ok(context.text.includes('修一下登录按钮'));
  assert.ok(context.text.includes('好的，我先看样式'));
  assert.ok(context.text.includes('补充说明'));
  assert.ok(!context.text.includes('内部推理'));
  assert.ok(!context.text.includes('不该出现'));
  assert.equal(shared.messageText({ role: 'tool', content: [{ type: 'text', text: 'x' }] }), '');
});

test('取样：单条消息超 300 字符时保留前 200 + 后 100', () => {
  const long = '头'.repeat(200) + '中'.repeat(200) + '尾'.repeat(100);
  const context = shared.buildRenameContext([userMessage(long)]);
  const sampled = context.tail;
  assert.ok(sampled.startsWith('头'.repeat(200)));
  assert.ok(sampled.endsWith('尾'.repeat(100)));
  assert.ok(sampled.includes('…'));
  assert.ok(!sampled.includes('中'.repeat(200)));
});

test('取样：尾部从最后一条往前累积 ≤1000 即止', () => {
  const messages = [];
  for (let index = 0; index < 10; index += 1) {
    messages.push(userMessage(`${index}:` + '字'.repeat(298))); // 每条 300
  }
  const context = shared.buildRenameContext(messages);
  assert.ok(context.tail.length <= 1000);
  assert.ok(context.tail.includes('9:')); // 最后一条必在
  assert.ok(!context.tail.includes('0:')); // 最早的进不来
  assert.ok(!context.tail.includes('5:')); // 超预算后更早的也进不来
});

test('取样：头部取首条 user 消息 ≤600，尾部已覆盖的短会话跳过头部', () => {
  // 长会话：尾部装不下首条 → 头部保留首条 user 消息（截到 600）
  const firstUser = '请帮我重构整个报表模块' + '长'.repeat(700);
  const messages = [userMessage(firstUser)];
  for (let index = 0; index < 10; index += 1) {
    messages.push(assistantMessage(`${index}:` + '答'.repeat(298)));
  }
  const longContext = shared.buildRenameContext(messages);
  assert.equal(longContext.head.length, 601); // 600 + 省略号
  assert.ok(longContext.head.startsWith('请帮我重构整个报表模块'));
  assert.ok(longContext.text.length <= 1600); // 上下文总硬上限

  // 短会话：尾部已含首条 user 消息 → head 为空，不重复
  const shortContext = shared.buildRenameContext([
    userMessage('改个颜色'),
    assistantMessage('改好了')
  ]);
  assert.equal(shortContext.head, '');
  assert.equal(shortContext.firstUserText, '改个颜色');
  assert.ok(shortContext.text.includes('改个颜色'));
});

test('prompt：含好/坏例子与 JSON 输出指令，emoji 开关控制输出格式', () => {
  const withEmoji = shared.buildRenamePrompt('上下文', { withEmoji: true });
  assert.ok(withEmoji.includes('好例子'));
  assert.ok(withEmoji.includes('坏例子'));
  assert.ok(withEmoji.includes('"emoji"'));
  assert.ok(withEmoji.includes('上下文'));

  const withoutEmoji = shared.buildRenamePrompt('上下文', { withEmoji: false });
  assert.ok(!withoutEmoji.includes('"emoji"'));
  assert.ok(withoutEmoji.includes('"title"'));
});

test('标题清洗：JSON 正常解析并拼 emoji；emoji 开关关闭时只留标题', () => {
  assert.equal(
    shared.sanitizeTitle('{"emoji":"🐛","title":"修复登录按钮移动端样式"}', { withEmoji: true }),
    '🐛 修复登录按钮移动端样式'
  );
  assert.equal(
    shared.sanitizeTitle('{"emoji":"🐛","title":"修复登录按钮移动端样式"}', { withEmoji: false }),
    '修复登录按钮移动端样式'
  );
  // 代码围栏包装也能解析
  assert.equal(
    shared.sanitizeTitle('```json\n{"emoji":"✨","title":"为报表接口补充分页参数"}\n```'),
    '✨ 为报表接口补充分页参数'
  );
  // 非法 emoji（纯文字）丢弃
  assert.equal(shared.sanitizeTitle('{"emoji":"ab","title":"排查定时任务"}'), '排查定时任务');
});

test('标题清洗：解析失败兜底、去引号、去结尾标点、超长截断', () => {
  // 非 JSON 输出：全文当标题
  assert.equal(shared.sanitizeTitle('修复登录按钮移动端样式'), '修复登录按钮移动端样式');
  // 引号与结尾标点清除
  assert.equal(shared.sanitizeTitle('"修复登录按钮样式。"'), '修复登录按钮样式');
  assert.equal(shared.sanitizeTitle('「排查定时任务偶发失败」！'), '排查定时任务偶发失败');
  // 空白折叠
  assert.equal(shared.sanitizeTitle('修复  登录\n按钮'), '修复 登录 按钮');
  // 超长截断到硬上限
  const long = shared.sanitizeTitle('标'.repeat(50));
  assert.equal(long.length, shared.TITLE_MAX_CHARS);
  // 空输入
  assert.equal(shared.sanitizeTitle(''), '');
  assert.equal(shared.sanitizeTitle('{"emoji":"🐛"}'), '');
});

test('自动标题启发式：title 与首条消息互为前缀才算自动标题', () => {
  const firstUser = '帮我修复登录按钮在移动端的样式问题';
  assert.equal(shared.looksLikeAutoTitle('帮我修复登录按钮', firstUser), true);
  assert.equal(shared.looksLikeAutoTitle(firstUser, '帮我修复登录按钮'), true);
  // 尾部省略号/截断忽略
  assert.equal(shared.looksLikeAutoTitle('帮我修复登录按钮在移动端的样式…', firstUser), true);
  assert.equal(shared.looksLikeAutoTitle('帮我修复登录按钮...', firstUser), true);
  // 用户手动改过的名字：不一致 → false
  assert.equal(shared.looksLikeAutoTitle('登录页样式专项', firstUser), false);
  assert.equal(shared.looksLikeAutoTitle('', firstUser), false);
  assert.equal(shared.looksLikeAutoTitle('标题', ''), false);
  // 服务端对 title 中的敏感路径打码为 [redacted]：按通配符比对
  const redactedFirst = '我要来修改/Users/gabriel/Documents/Coding/kimi-code-monitor 这个插件，请你先简单浏览一遍内容';
  assert.equal(shared.looksLikeAutoTitle('我要来修改/[redacted]，请你先简单浏览一遍内容', redactedFirst), true);
  assert.equal(shared.looksLikeAutoTitle('/[redacted]，帮我修复一下这个Chrome插件', '/Users/gabriel/x，帮我修复一下这个Chrome插件'), true);
  // 打码标题但前后文对不上：仍是手动标题
  assert.equal(shared.looksLikeAutoTitle('我要来修改/[redacted]，请你先简单浏览一遍内容', '帮我看看这个目录里有什么'), false);
  // 空白差异忽略：服务端生成标题时会折叠/增删空格
  assert.equal(
    shared.looksLikeAutoTitle('为什么没反应： ▐█▛█▛█▌ Kimi server ready', '为什么没反应：  ▐█▛█▛█▌  Kimi server ready 0.32.0'),
    true
  );
  assert.equal(
    shared.looksLikeAutoTitle('安装一下这个skill Attache', '安装一下这个skillAttached file "ex.zip"'),
    true
  );
  // 斜杠命令会话：标题是命令名，首条是技能激活文本
  assert.equal(shared.looksLikeAutoTitle('/goodnotes-extractor', 'User activated the skill "goodnotes-extractor". Follow the instructions…'), true);
  assert.equal(shared.looksLikeAutoTitle('/kimi-webbridge', 'User activated the skill "kimi-webbridge".'), true);
  // 手动改的名字不是命令形式，不受影响
  assert.equal(shared.looksLikeAutoTitle('提取 GoodNotes 录音', 'User activated the skill "goodnotes-extractor".'), false);
  // 真实案例 1：打码段在原文里是超长 attachments 路径（>120 字符），头部前缀应判自动
  assert.equal(
    shared.looksLikeAutoTitle(
      '安装一下这个skill，顺便看看有什么地方可以优化的吗 Attached file "express-query.zip" (application/zip, 14327 bytes): /Users/gabriel/.[redacted].zip — open it with the Read tool',
      '安装一下这个skill，顺便看看有什么地方可以优化的吗Attached file "express-query.zip" (application/zip, 14327 bytes): /Users/gabriel/.kimi-code/sessions/wd_gabriel_edcc0bdde681/session_15fa5eb6-e251-4ccf-8188-0a5aecf72f2a/attachments/f_1225344a-30a3-42fc-9d87-64d376333a6c-express-query.zip — open it with the Read tool'
    ),
    true
  );
  // 真实案例 2：打码处标点被改写（Token: → Token=），头部 40 字前缀仍判自动
  assert.equal(
    shared.looksLikeAutoTitle(
      '为什么没反应： ▐█▛█▛█▌ Kimi server ready 0.32.0 ▐█████▌ Local web UI is available from this machine. Local: http://127.0.0.1:58627/#token=[redacted] Network: off',
      '为什么没反应：  ▐█▛█▛█▌  Kimi server ready  0.32.0\n  ▐█████▌  Local web UI is available from this machine.\n\n  Local:    http://127.0.0.1:58627/#token=_Yzb0rIwrmOGm6e1YnmKMmNdxqfqXKAcrP4KHSOdxo0\n  Network:  off'
    ),
    true
  );
  // 头部前缀规则不放宽到前 40 字之后：开头就不同的手动标题仍判手动
  assert.equal(
    shared.looksLikeAutoTitle('专报撰写：政策汇编整理与大纲 v3', '为什么没反应：  ▐█▛█▛█▌  Kimi server ready 0.32.0'),
    false
  );
});

test('首条消息回翻：role=user 过滤 + before_id 真实 id 逐页向旧，不用合成锚点', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'session-rename', 'rename-content.js'), 'utf8');
  assert.match(content, /role=user&page_size=100/);
  assert.match(content, /before_id=/);
  assert.doesNotMatch(content, /msg_\$\{sessionId\}_000010/);
  // 接口新→旧排序，fetchMessages 翻转为时间正序供尾部取样
  assert.match(content, /items\.slice\(\)\.reverse\(\)/);
  // 启发式对所有会话生效（兜底 CLI 覆盖不到的会话），不因 customTitleIds 而跳过
  assert.doesNotMatch(content, /if \(!customTitleIds\) \{\s*firstUserText/);
});

test('取样：提供真实首条消息时头部用它，页内已覆盖则去重', () => {
  // 长会话：尾部页不含首条 → 头部用提供的真实首条消息
  const longSession = [
    { role: 'user', content: [{ type: 'text', text: '中间某轮的问题' }] },
    { role: 'assistant', content: [{ type: 'text', text: '中间某轮的回答' }] }
  ];
  const withHead = shared.buildRenameContext(longSession, { firstUserText: '最初的需求描述' });
  assert.equal(withHead.head, '最初的需求描述');
  assert.ok(withHead.text.startsWith('最初的需求描述'));
  // 短会话：页内首条与真实首条一致 → 不重复头部
  const shortSession = [
    { role: 'user', content: [{ type: 'text', text: '最初的需求描述' }] },
    { role: 'assistant', content: [{ type: 'text', text: '回答' }] }
  ];
  const deduped = shared.buildRenameContext(shortSession, { firstUserText: '最初的需求描述' });
  assert.equal(deduped.head, '');
});

test('跳过规则：busy/archived/已命名/CLI 自定义标题（message_count 恒为 0，不作判据）', () => {
  const session = { id: 's1', busy: false, archived: false, message_count: 5 };
  assert.equal(shared.skipSessionReason(session), '');
  assert.equal(shared.skipSessionReason({ ...session, busy: true }), 'busy');
  assert.equal(shared.skipSessionReason({ ...session, archived: true }), 'archived');
  // 列表接口的 message_count 恒为 0（非真实计数），不参与跳过判定
  assert.equal(shared.skipSessionReason({ ...session, message_count: 0 }), '');
  assert.equal(
    shared.skipSessionReason(session, { renameLog: { s1: { title: 'x', renamedAt: 1 } } }),
    'already-renamed'
  );
  assert.equal(
    shared.skipSessionReason(session, { customTitleIds: new Set(['s1']) }),
    'custom-title'
  );
  assert.equal(shared.skipSessionReason(null), 'no-id');
});

test('modelSource 迁移：旧字符串值归一化为新结构，默认 K2.7 Coding（低价）', () => {
  const defaultModel = { kind: 'kimi-code', model: 'kimi-code/kimi-for-coding' };
  assert.deepEqual(shared.normalizeModelSource(undefined), defaultModel);
  assert.deepEqual(shared.normalizeModelSource(null), defaultModel);
  assert.deepEqual(shared.normalizeModelSource('kimi'), defaultModel);
  assert.deepEqual(shared.normalizeModelSource(''), defaultModel);
  assert.deepEqual(shared.normalizeModelSource('ext:ext-123'), {
    kind: 'external',
    accountId: 'ext-123'
  });
  // 新结构原样保留
  assert.deepEqual(shared.normalizeModelSource({ kind: 'kimi-code', model: 'kimi-code/k3' }), {
    kind: 'kimi-code',
    model: 'kimi-code/k3'
  });
  assert.deepEqual(shared.normalizeModelSource({ kind: 'external', accountId: 'ext-9' }), {
    kind: 'external',
    accountId: 'ext-9'
  });
  // 残缺对象回落默认
  assert.deepEqual(shared.normalizeModelSource({ kind: 'kimi-code' }), defaultModel);
  assert.deepEqual(shared.normalizeModelSource({ kind: 'weird', model: 'x' }), defaultModel);
});

test('Kimi Code 模型兜底清单：四项，默认 K2.7 Coding 居首', () => {
  assert.equal(shared.KIMI_CODE_FALLBACK_MODELS.length, 4);
  assert.equal(shared.KIMI_CODE_FALLBACK_MODELS[0].model, 'kimi-code/kimi-for-coding');
  assert.equal(shared.KIMI_CODE_FALLBACK_MODELS[0].display_name, 'K2.7 Coding');
  assert.deepEqual(
    shared.KIMI_CODE_FALLBACK_MODELS.map((entry) => entry.model),
    ['kimi-code/kimi-for-coding', 'kimi-code/kimi-for-coding-highspeed', 'kimi-code/k3', 'kimi-code/k3-256k']
  );
  assert.equal(shared.DEFAULT_KIMI_CODE_MODEL, 'kimi-code/kimi-for-coding');
  assert.deepEqual(shared.defaultModelSource(), {
    kind: 'kimi-code',
    model: 'kimi-code/kimi-for-coding'
  });
});

test('模型清单过滤：只留 managed:kimi-code，display_name 缺省回退 model id', () => {
  const items = [
    { provider: 'managed:kimi-code', model: 'kimi-code/k3', display_name: 'K3' },
    { provider: 'managed:other', model: 'other/x', display_name: '别的' },
    { provider: 'managed:kimi-code', model: 'kimi-code/k3-256k' },
    { provider: 'managed:kimi-code', model: '' }
  ];
  assert.deepEqual(shared.kimiCodeModelsFromResponse(items), [
    { model: 'kimi-code/k3', display_name: 'K3' },
    { model: 'kimi-code/k3-256k', display_name: 'kimi-code/k3-256k' }
  ]);
  assert.deepEqual(shared.kimiCodeModelsFromResponse(null), []);
});

test('接线：manifest 与 build.sh 登记新文件，background/content 挂接 rename 管线', () => {
  const contentScripts = manifest.content_scripts[0].js;
  assert.ok(contentScripts.includes('session-rename/rename-shared.js'));
  assert.ok(contentScripts.includes('session-rename/rename-content.js'));
  // rename-content 必须先于 content.js 注入，turn.ended 钩子才找得到它
  assert.ok(
    contentScripts.indexOf('session-rename/rename-content.js') < contentScripts.indexOf('content.js')
  );
  assert.match(buildSh, /session-rename/);

  assert.match(backgroundSource, /importScripts\([\s\S]*?session-rename\/rename-shared\.js/);
  assert.match(backgroundSource, /importScripts\([\s\S]*?session-rename\/rename-model\.js/);
  assert.match(backgroundSource, /'rename\.model': renameModelCall/);
  // 批量功能已移除：background 不再注册 rename.batch.*
  assert.doesNotMatch(backgroundSource, /rename\.batch\./);
  // 模型清单中转：popup → background → content 同源拉 /api/v1/models
  assert.match(backgroundSource, /'rename\.models\.list': listRenameModels/);
  assert.match(backgroundSource, /relayToKimiWebTab\('rename\.models\.fetch'\)/);
  const renameContentSource = fs.readFileSync(
    path.join(root, 'session-rename', 'rename-content.js'),
    'utf8'
  );
  assert.match(renameContentSource, /apiGet\('\/api\/v1\/models'\)/);
  assert.match(renameContentSource, /kimiCodeModelsFromResponse/);
  assert.match(renameContentSource, /message\?\.type === 'rename\.models\.fetch'/);
  // content 无批量管线与诊断日志
  assert.doesNotMatch(renameContentSource, /rename\.batch\.|debugLog|sessionRenameDebug/);

  // Kimi Code 账户端点未实测：鉴权类失败必须结构化报错，不许重试；模型 id 由调用方透传
  assert.match(
    backgroundSource,
    /KimiSessionRenameModel\.callKimiCode\(token\.access_token, prompt, modelSource\.model\)/
  );
  const modelSource = fs.readFileSync(
    path.join(root, 'session-rename', 'rename-model.js'),
    'utf8'
  );
  assert.match(modelSource, /KIMI_MODEL_UNAVAILABLE/);
  assert.match(modelSource, /response\.status === 401 \|\| response\.status === 403 \|\| response\.status === 404/);
  assert.match(modelSource, /const KIMI_CODE_MODEL = 'kimi-code\/kimi-for-coding'/);
  // kimi-for-coding 强制思考且较慢，超时放宽到 90s（30s 实测撞墙）
  assert.match(modelSource, /const REQUEST_TIMEOUT_MS = 90_000/);
  // 自动命名在第 3 轮对话结束后才触发（首轮内容太少），轮数不足不消耗尝试次数；
  // usage.turn_count 恒为 0 不可用，用 role=user&page_size=100 的条数近似轮数
  assert.match(renameContentSource, /const AUTO_RENAME_MIN_TURNS = 3/);
  assert.match(renameContentSource, /hasEnoughTurns/);
  assert.doesNotMatch(renameContentSource, /usage\?\.turn_count/);

  // 用量提取：Anthropic 与 OpenAI 两种 usage 形状，随成功调用累计到 sessionRenameUsage
  assert.match(modelSource, /usage\.input_tokens \?\? usage\.prompt_tokens/);
  assert.match(modelSource, /usage\.output_tokens \?\? usage\.completion_tokens/);
  assert.match(backgroundSource, /'rename\.usage\.get': getRenameUsage/);
  assert.match(backgroundSource, /recordRenameUsage\(result\.usage\)/);
  assert.match(backgroundSource, /const RENAME_USAGE_STORAGE_KEY = 'sessionRenameUsage'/);

  // content.js 的 turn.ended 钩子
  assert.match(contentSource, /globalThis\.KimiSessionRename\?\.onTurnEnded\?\.\(sessionId\)/);
});

test('授权横幅小字：缩短为「授权后显示额度与预警」', () => {
  assert.match(contentSource, /授权后显示额度与预警/);
  assert.doesNotMatch(contentSource, /授权后显示 5h/);
});
