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
