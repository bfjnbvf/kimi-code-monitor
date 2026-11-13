import test from 'node:test';
import assert from 'node:assert/strict';
import { createProtocol3Transcript, serverProtocolVersion, transcriptEvents } from '../src/transcript.js';

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

const protocol3Usage = {
  input_other: 120,
  output: 200,
  input_cache_read: 80,
  input_cache_creation: 0
};

test('新协议历史快照关联步骤、模型与计时，不携带对话正文', () => {
  const transcript = createProtocol3Transcript();
  transcript.events({ type: 'agent', session_id: 's1', agent_id: 'main', status: 'idle', model: 'k3' });
  const events = transcript.events({
    type: 'turns', session_id: 's1', agent_id: 'main',
    turns: [{
      turn_id: 't1', status: 'ended', outcome: 'completed', duration_ms: 8_000,
      steps: [{ index: 1, outcome: 'completed', usage: protocol3Usage }],
      items: [{
        item_id: 'assistant-1', type: 'assistant_message', step_index: 1, status: 'ended',
        text: '不得透传', debug: { timing: { stream_ms: 2_000 } }
      }]
    }]
  });
  assert.deepEqual(events.map((event) => event.type), ['turn.step.completed', 'turn.ended']);
  assert.equal(events[0].payload.stepId, 't1.1');
  assert.equal(events[0].payload.model, 'k3');
  assert.equal(events[0].payload.llmTiming.llmStreamDurationMs, 2_000);
  assert.equal(events[1].payload.durationMs, 8_000);
  assert.equal(JSON.stringify(events).includes('不得透传'), false);
});

test('新协议实时步骤使用已结束项目的计时，并发现子代理', () => {
  const transcript = createProtocol3Transcript();
  transcript.events({
    type: 'task.list', session_id: 's1', agent_id: 'main',
    tasks: [{ task_id: 'task-1', child_agent_id: 'agent-1', status: 'running' }]
  });
  assert.deepEqual(transcript.subscribedAgentIds(), ['main', 'agent-1']);
  transcript.events({ type: 'agent', session_id: 's1', agent_id: 'agent-1', status: 'running', model: 'small' });
  transcript.events({
    type: 'item.ended', session_id: 's1', agent_id: 'agent-1', turn_id: 't2',
    item: {
      item_id: 'assistant-2', type: 'assistant_message', step_index: 2, status: 'ended',
      debug: { timing: { server_decode_ms: 1_000 } }
    }
  });
  const events = transcript.events({
    type: 'turn.updated', session_id: 's1', agent_id: 'agent-1', turn_id: 't2',
    step: { index: 2, outcome: 'completed', usage: protocol3Usage }
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].agent_id, 'agent-1');
  assert.equal(events[0].payload.stepId, 't2.2');
  assert.equal(events[0].payload.model, 'small');
  assert.equal(events[0].payload.llmTiming.llmServerDecodeMs, 1_000);
});


test('正式模式缺少 debug 时按内容时间计算流式耗时，不计入工具执行时间', () => {
  const transcript = createProtocol3Transcript();
  const events = transcript.events({
    type: 'turns', session_id: 's1', agent_id: 'main',
    turns: [{
      turn_id: 't3', status: 'ended', outcome: 'completed',
      steps: [{
        index: 1, outcome: 'completed', usage: protocol3Usage,
        ended_at: '2026-01-01T00:00:05.000Z'
      }],
      items: [
        {
          item_id: 'reasoning-3', type: 'reasoning', step_index: 1, status: 'ended',
          created_at: '2026-01-01T00:00:01.000Z'
        },
        {
          item_id: 'assistant-3', type: 'assistant_message', step_index: 1, status: 'ended',
          created_at: '2026-01-01T00:00:02.000Z'
        },
        {
          item_id: 'tool-3', type: 'tool_call', step_index: 1, status: 'ended',
          created_at: '2026-01-01T00:00:03.000Z', started_at: '2026-01-01T00:00:03.000Z'
        }
      ]
    }]
  });
  assert.equal(events[0].payload.llmTiming.llmStreamDurationMs, 2_000);
});
