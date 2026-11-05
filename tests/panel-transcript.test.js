import test from 'node:test';
import assert from 'node:assert/strict';
import { serverProtocolVersion, transcriptEvents } from '../src/transcript.js';

const usage = { inputOther: 120, inputCacheRead: 80, inputCacheCreation: 0, output: 200 };
const llmTiming = { llmFirstTokenLatencyMs: 500, llmStreamDurationMs: 2_000 };

function completedStep(stepId = 't1.1') {
  return {
    kind: 'step', stepId, turnId: 't1', ordinal: 1, state: 'completed',
    usage, llmTiming
  };
}

test('协议版本默认走旧协议，版本 2 走转录协议', () => {
  assert.equal(serverProtocolVersion({ type: 'server_hello', payload: {} }), 1);
  assert.equal(serverProtocolVersion({ type: 'server_hello', payload: { protocol_version: 2 } }), 2);
});

test('历史快照逐步骤恢复样本，运行中的步骤不进入完成事件', () => {
  const events = transcriptEvents({
    type: 'transcript.reset', session_id: 's1', timestamp: '2026-11-05T00:00:00Z',
    payload: {
      agent_id: 'main', seq: 10,
      snapshot: {
        items: [{
          kind: 'turn', turnId: 't1', state: 'completed',
          steps: [completedStep('t1.1'), completedStep('t1.2'), { kind: 'step', stepId: 't1.3', state: 'running' }]
        }]
      }
    }
  });
  assert.equal(events.length, 2);
  assert.deepEqual(events.map(event => event.payload.stepId), ['t1.1', 't1.2']);
  assert.ok(events.every(event => event.type === 'turn.step.completed' && event.kcmTranscript));
  assert.equal(events[0].payload.llmTiming.llmStreamDurationMs, 2_000);
});

test('实时增量映射步骤生命周期和轮次结束，不携带对话正文', () => {
  const events = transcriptEvents({
    type: 'transcript.ops', session_id: 's1',
    payload: {
      agent_id: 'agent-1', seq: 11,
      ops: [
        { op: 'step.upsert', turnId: 't1', step: { kind: 'step', stepId: 't1.2', turnId: 't1', state: 'running' } },
        { op: 'step.upsert', turnId: 't1', step: { ...completedStep('t1.2'), prompt: '不得透传' } },
        { op: 'turn.upsert', turn: { kind: 'turn', turnId: 't1', state: 'completed', durationMs: 8_000 } }
      ]
    }
  });
  assert.deepEqual(events.map(event => event.type), ['turn.step.started', 'turn.step.completed', 'turn.ended']);
  assert.ok(events.every(event => event.agent_id === 'agent-1'));
  assert.equal(events[2].payload.durationMs, 8_000);
  assert.equal(JSON.stringify(events).includes('不得透传'), false);
});

test('异常或缺少用量的步骤不会伪造完成样本', () => {
  const events = transcriptEvents({
    type: 'transcript.ops', session_id: 's1',
    payload: {
      agent_id: 'main',
      ops: [
        { op: 'step.upsert', turnId: 't1', step: { kind: 'step', stepId: 't1.1', state: 'queued' } },
        { op: 'step.upsert', turnId: 't1', step: { kind: 'step', stepId: 't1.2', state: 'completed' } },
        { op: 'frame.upsert', turnId: 't1', stepId: 't1.2', frame: { kind: 'tool', input: 'ignored' } }
      ]
    }
  });
  assert.deepEqual(events, []);
  assert.deepEqual(transcriptEvents({ type: 'turn.step.completed', payload: { usage } }), []);
});
