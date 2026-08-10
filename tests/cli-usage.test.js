const test = require('node:test');
const assert = require('node:assert/strict');

const KimiCliUsage = require('../cli-usage.js');

function usageLine({ inputOther = 0, cacheRead = 0, cacheCreation = 0, output = 0, time = 0 }) {
  return JSON.stringify({
    type: 'usage.record',
    model: 'kimi-code/test',
    usage: {
      inputOther,
      inputCacheRead: cacheRead,
      inputCacheCreation: cacheCreation,
      output
    },
    usageScope: 'turn',
    time
  });
}

test('只累计 usage.record，不解析包含同名文本的对话记录', () => {
  const daily = {};
  const text = [
    JSON.stringify({ type: 'turn.prompt', input: '请解释 usage.record' }),
    usageLine({ inputOther: 10, cacheRead: 20, cacheCreation: 5, output: 3, time: 1785686400000 })
  ].join('\n');

  assert.equal(KimiCliUsage.parseUsageLines(text, daily), 1);
  assert.deepEqual(daily['2026-08-03'], { input: 35, output: 3, cacheRead: 20 });
});

test('文件末尾半行不推进偏移，下次写完整后只补记一次', async () => {
  const first = usageLine({ inputOther: 10, time: 1785686400000 });
  const second = usageLine({ cacheRead: 20, output: 4, time: 1785686401000 });
  const initialText = `${first}\n${second}`;
  const initialFile = new File([initialText], 'wire.jsonl', { lastModified: 1000 });

  const initial = await KimiCliUsage.scanFile(initialFile, null);
  assert.equal(initial.usageRecords, 1);
  assert.equal(initial.offset, new TextEncoder().encode(`${first}\n`).byteLength);

  const completedFile = new File([`${initialText}\n`], 'wire.jsonl', { lastModified: 2000 });
  const completed = await KimiCliUsage.scanFile(completedFile, initial);
  assert.equal(completed.usageRecords, 2);
  assert.deepEqual(completed.daily['2026-08-03'], { input: 30, output: 4, cacheRead: 20 });
});

test('同大小文件被改写时重建该文件统计，不与旧结果叠加', async () => {
  const beforeFile = new File([
    `${usageLine({ inputOther: 1, time: 1785686400000 })}\n`
  ], 'wire.jsonl', { lastModified: 1000 });
  const before = await KimiCliUsage.scanFile(beforeFile, null);

  const afterFile = new File([
    `${usageLine({ inputOther: 9, time: 1785686400000 })}\n`
  ], 'wire.jsonl', { lastModified: 2000 });
  assert.equal(afterFile.size, beforeFile.size);
  const after = await KimiCliUsage.scanFile(afterFile, before);

  assert.equal(after.usageRecords, 1);
  assert.deepEqual(after.daily['2026-08-03'], { input: 9, output: 0, cacheRead: 0 });
});

test('子代理文件同额累加进 sub 子桶，合流后保留主/子拆分', async () => {
  const daily = {};
  const line = usageLine({ inputOther: 10, cacheRead: 20, output: 3, time: 1785686400000 });
  assert.equal(KimiCliUsage.parseUsageLines(line, daily, true), 1);
  assert.deepEqual(daily['2026-08-03'], {
    input: 30, output: 3, cacheRead: 20,
    sub: { input: 30, output: 3, cacheRead: 20 }
  });

  // 主子两个文件的按日汇总合流：总量相加，sub 只来自子代理文件
  const mainFile = new File([`${line}\n`], 'wire.jsonl', { lastModified: 1000 });
  const subFile = new File([`${line}\n`], 'wire.jsonl', { lastModified: 1000 });
  const mainScan = await KimiCliUsage.scanFile(mainFile, null, undefined, false);
  const subScan = await KimiCliUsage.scanFile(subFile, null, undefined, true);
  const combined = KimiCliUsage.combineFileDaily({ main: mainScan, sub: subScan });
  assert.deepEqual(combined['2026-08-03'], {
    input: 60, output: 6, cacheRead: 40,
    sub: { input: 30, output: 3, cacheRead: 20 }
  });
});

test('按会话汇总包含按代理拆分：模型分布与起止时间', () => {
  const main = {};
  const sub = {};
  const mainMeta = { models: {}, firstAt: null, lastAt: null };
  const subMeta = { models: {}, firstAt: null, lastAt: null };
  KimiCliUsage.parseUsageLines(
    usageLine({ inputOther: 10, cacheRead: 20, output: 3, time: 1785686400000 }),
    main, false, mainMeta
  );
  KimiCliUsage.parseUsageLines(
    JSON.stringify({
      type: 'usage.record',
      model: 'kimi-code/k3',
      usage: { inputOther: 5, inputCacheRead: 7, inputCacheCreation: 0, output: 2 },
      usageScope: 'turn',
      time: 1785686500000
    }),
    sub, true, subMeta
  );
  const sessions = KimiCliUsage.summarizeSessions({
    'ws/session_a/agents/main/wire.jsonl': { daily: main, meta: mainMeta },
    'ws/session_a/agents/agent-0/wire.jsonl': { daily: sub, meta: subMeta }
  });
  const entry = sessions.session_a;
  assert.equal(entry.input, 42);
  assert.deepEqual(entry.sub, { input: 12, output: 2, cacheRead: 7 });
  assert.equal(entry.agents.main.input, 30);
  assert.equal(entry.agents['agent-0'].input, 12);
  assert.equal(entry.agents['agent-0'].models['kimi-code/k3'], 14);
  assert.equal(entry.agents['agent-0'].firstAt, 1785686500000);
  assert.equal(entry.agents.main.lastAt, 1785686400000);
});

test('目录扫描按实际读取量报告百分比，并以 100 结束', async () => {
  const wire = new File([
    `${usageLine({ inputOther: 10, cacheRead: 30, time: 1785686400000 })}\n`
  ], 'wire.jsonl', { lastModified: 1000 });
  const wireHandle = { async getFile() { return wire; } };
  const agentHandle = { kind: 'directory', async getFileHandle() { return wireHandle; } };
  const agentsHandle = {
    async *entries() { yield ['main', agentHandle]; }
  };
  const sessionHandle = {
    kind: 'directory',
    async getDirectoryHandle(name) {
      if (name !== 'agents') throw new Error('not found');
      return agentsHandle;
    }
  };
  const workspaceHandle = {
    kind: 'directory',
    async *entries() { yield ['session_1', sessionHandle]; }
  };
  const sessionsHandle = {
    async *entries() { yield ['workspace', workspaceHandle]; }
  };
  const progress = [];

  const result = await KimiCliUsage.scanSessionsDirectory(
    sessionsHandle,
    null,
    (percent) => progress.push(percent)
  );

  assert.equal(progress[0], 0);
  assert.equal(progress.at(-1), 100);
  assert.equal(result.fileCount, 1);
  assert.deepEqual(result.daily['2026-08-03'], { input: 40, output: 0, cacheRead: 30 });
});

test('单个 wire.jsonl 读取失败不中断整次扫描（网络盘容错）', async () => {
  const good = new File([
    `${usageLine({ inputOther: 10, time: 1785686400000 })}\n`
  ], 'wire.jsonl', { lastModified: 1000 });
  const goodWire = { async getFile() { return good; } };
  const badWire = { async getFile() { throw new Error('NotReadableError'); } };
  const mainAgent = { kind: 'directory', async getFileHandle() { return goodWire; } };
  const subAgent = { kind: 'directory', async getFileHandle() { return badWire; } };
  const agentsHandle = {
    async *entries() { yield ['main', mainAgent]; yield ['agent-1', subAgent]; }
  };
  const sessionHandle = {
    kind: 'directory',
    async getDirectoryHandle(name) {
      if (name !== 'agents') throw new Error('not found');
      return agentsHandle;
    }
  };
  const workspaceHandle = {
    kind: 'directory',
    async *entries() { yield ['session_1', sessionHandle]; }
  };
  const sessionsHandle = {
    async *entries() { yield ['workspace', workspaceHandle]; }
  };

  const result = await KimiCliUsage.scanSessionsDirectory(sessionsHandle, null, () => {});
  assert.equal(result.fileCount, 2);
  assert.equal(result.skippedFiles, 1);
  assert.match(result.firstError, /NotReadableError/);
  // 好文件的数据不受影响
  assert.deepEqual(result.daily['2026-08-03'], { input: 10, output: 0, cacheRead: 0 });
});

test('纯追加（上次已扫到旧文件尾且文件变大）从旧偏移续扫并沿用旧统计', async () => {
  const first = `${usageLine({ inputOther: 10, time: 1785686400000 })}\n`;
  const initialFile = new File([first], 'wire.jsonl', { lastModified: 1000 });
  const initial = await KimiCliUsage.scanFile(initialFile, null);
  assert.equal(initial.offset, initialFile.size);

  const appendedFile = new File([
    first + `${usageLine({ cacheRead: 20, output: 4, time: 1785686401000 })}\n`
  ], 'wire.jsonl', { lastModified: 2000 });
  const appended = await KimiCliUsage.scanFile(appendedFile, initial);
  assert.equal(appended.usageRecords, 2);
  assert.deepEqual(appended.daily['2026-08-03'], { input: 30, output: 4, cacheRead: 20 });
});

test('上次未扫到旧文件尾（offset !== size）时回退全量重扫，daily 从空重建', async () => {
  // 首次扫描末尾留有半行：offset 停在完整行之后，小于文件 size
  const first = usageLine({ inputOther: 1, time: 1785686400000 });
  const initialFile = new File([`${first}\npartial`], 'wire.jsonl', { lastModified: 1000 });
  const initial = await KimiCliUsage.scanFile(initialFile, null);
  assert.equal(initial.usageRecords, 1);
  assert.ok(initial.offset < initial.size);

  // 文件随后被截断重写为更大的新内容（原子替换）：若沿用旧偏移续扫，
  // 新文件头部会永久漏计。offset !== size 不满足纯追加特征，必须全量重扫
  const replacedText = [
    `${usageLine({ inputOther: 5, time: 1785686401000 })}\n`,
    `${usageLine({ inputOther: 7, cacheRead: 2, time: 1785686402000 })}\n`
  ].join('');
  const replacedFile = new File([replacedText], 'wire.jsonl', { lastModified: 2000 });
  assert.ok(replacedFile.size > initial.offset);

  const after = await KimiCliUsage.scanFile(replacedFile, initial);
  assert.equal(after.offset, replacedFile.size);
  assert.equal(after.usageRecords, 2);
  // daily 从空重建：只含新文件内容，不与旧结果叠加
  assert.deepEqual(after.daily['2026-08-03'], { input: 14, output: 0, cacheRead: 2 });
});
