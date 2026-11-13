const TERMINAL_STEP_STATES = new Set(['completed', 'failed', 'aborted', 'interrupted']);
const TERMINAL_TURN_STATES = new Set(['completed', 'failed', 'aborted', 'interrupted']);

export function serverProtocolVersion(message) {
  const version = Number(message?.payload?.protocol_version);
  return Number.isFinite(version) ? version : 1;
}

export function stepEventKey(payload, agentId = 'main') {
  const id = payload.stepId || payload.uuid || '';
  return id ? `${agentId}:${id}` : '';
}

function stepPayload(step) {
  return {
    usage: step.usage,
    model: step.model,
    modelAlias: step.modelAlias,
    stepId: step.stepId,
    turnId: step.turnId,
    ordinal: step.ordinal,
    state: step.state,
    finishReason: step.finishReason,
    llmTiming: step.llmTiming
  };
}

function event(message, agentId, type, payload) {
  return {
    type,
    session_id: message.session_id,
    agent_id: agentId,
    timestamp: message.timestamp ?? message.event_created_at,
    payload,
    kcmTranscript: true
  };
}

function stepEvent(message, agentId, step) {
  if (!step || typeof step !== 'object') return null;
  if (step.state === 'running') return event(message, agentId, 'turn.step.started', stepPayload(step));
  if (!TERMINAL_STEP_STATES.has(step.state) || !step.usage) return null;
  return event(message, agentId, 'turn.step.completed', stepPayload(step));
}

function turnEvent(message, agentId, turn) {
  if (!turn || typeof turn !== 'object') return null;
  if (turn.state === 'running') return event(message, agentId, 'turn.started', { turnId: turn.turnId });
  if (!TERMINAL_TURN_STATES.has(turn.state)) return null;
  return event(message, agentId, 'turn.ended', {
    turnId: turn.turnId,
    state: turn.state,
    durationMs: turn.durationMs
  });
}

function resetEvents(message, payload) {
  const agentId = payload.agent_id || 'main';
  const events = [];
  for (const item of payload.snapshot?.items || []) {
    const steps = item.kind === 'turn' ? item.steps || [] : item.kind === 'step' ? [item] : [];
    for (const step of steps) {
      const converted = stepEvent(message, agentId, step);
      if (converted?.type === 'turn.step.completed') events.push(converted);
    }
  }
  return events;
}

export function transcriptEvents(message) {
  const payload = message?.payload;
  if (!payload || typeof payload !== 'object') return [];
  if (message.type === 'transcript.reset') return resetEvents(message, payload);
  if (message.type !== 'transcript.ops') return [];
  const agentId = payload.agent_id || 'main';
  const events = [];
  for (const op of payload.ops || []) {
    let converted = null;
    if (op.op === 'step.upsert') converted = stepEvent(message, agentId, op.step);
    else if (op.op === 'turn.upsert') converted = turnEvent(message, agentId, op.turn);
    if (converted) events.push(converted);
  }
  return events;
}

const PROTOCOL3_CACHE_LIMIT = 500;

function rememberBounded(map, key, value) {
  map.delete(key);
  map.set(key, value);
  if (map.size > PROTOCOL3_CACHE_LIMIT) map.delete(map.keys().next().value);
}

function protocol3StepKey(agentId, turnId, stepIndex) {
  return `${agentId}\0${turnId}\0${stepIndex}`;
}

function protocol3Timing(timing, step, hints) {
  let streamDuration = timing?.stream_ms;
  if (streamDuration == null && Number.isFinite(hints?.firstContentAt)) {
    const streamEnd = hints.firstToolAt ?? Date.parse(step?.ended_at || '');
    const duration = streamEnd - hints.firstContentAt;
    if (Number.isFinite(duration) && duration >= 0) streamDuration = duration;
  }
  if (!timing && streamDuration == null) return undefined;
  return {
    llmFirstTokenLatencyMs: timing?.first_token_ms ?? timing?.server_first_token_ms,
    llmStreamDurationMs: streamDuration,
    llmServerDecodeMs: timing?.server_decode_ms
  };
}

export function createProtocol3Transcript() {
  const modelsByAgent = new Map();
  const timingByStep = new Map();
  const timingHintsByStep = new Map();
  const itemTypes = new Map();
  const agentIds = new Set(['main']);

  function noteAgent(agentId) {
    if (typeof agentId === 'string' && agentId) agentIds.add(agentId);
  }

  function noteTask(task) {
    noteAgent(task?.child_agent_id);
  }

  function noteItem(message, turnId, item) {
    if (!item || typeof item !== 'object') return;
    const agentId = message.agent_id || 'main';
    if (item.item_id) {
      rememberBounded(itemTypes, protocol3StepKey(agentId, turnId, item.item_id), item.type);
    }
    if (item.step_index != null) {
      const stepKey = protocol3StepKey(agentId, turnId, item.step_index);
      if (item.debug?.timing) rememberBounded(timingByStep, stepKey, item.debug.timing);
      const hints = timingHintsByStep.get(stepKey) || {};
      if (item.type === 'reasoning' || item.type === 'assistant_message') {
        const contentAt = Date.parse(item.created_at || item.started_at || '');
        if (Number.isFinite(contentAt)) {
          hints.firstContentAt = Math.min(hints.firstContentAt ?? Infinity, contentAt);
        }
      }
      if (item.type === 'tool_call') {
        const toolAt = Date.parse(item.started_at || item.created_at || '');
        if (Number.isFinite(toolAt)) hints.firstToolAt = Math.min(hints.firstToolAt ?? Infinity, toolAt);
      }
      rememberBounded(timingHintsByStep, stepKey, hints);
    }
  }

  function noteTurn(message, turn) {
    for (const item of turn?.items || []) noteItem(message, turn.turn_id, item);
  }

  function protocol3StepEvent(message, turnId, step) {
    if (!step || typeof step !== 'object' || !step.usage) return null;
    const agentId = message.agent_id || 'main';
    const timing = timingByStep.get(protocol3StepKey(agentId, turnId, step.index));
    return event(message, agentId, 'turn.step.completed', {
      usage: step.usage,
      model: modelsByAgent.get(agentId),
      stepId: `${turnId}.${step.index}`,
      turnId,
      ordinal: step.index,
      state: step.outcome,
      finishReason: step.finish_reason,
      llmTiming: protocol3Timing(
        timing,
        step,
        timingHintsByStep.get(protocol3StepKey(agentId, turnId, step.index))
      )
    });
  }

  function protocol3TurnEvent(message, turn) {
    if (!turn || typeof turn !== 'object') return null;
    const agentId = message.agent_id || 'main';
    if (turn.status === 'running') {
      return event(message, agentId, 'turn.started', { turnId: turn.turn_id });
    }
    if (turn.status !== 'ended') return null;
    return event(message, agentId, 'turn.ended', {
      turnId: turn.turn_id,
      state: turn.outcome,
      durationMs: turn.duration_ms
    });
  }

  function protocol3TurnEvents(message, turn, includeSteps) {
    if (!turn || typeof turn !== 'object') return [];
    noteTurn(message, turn);
    const events = [];
    if (includeSteps) {
      for (const step of turn?.steps || []) {
        const converted = protocol3StepEvent(message, turn.turn_id, step);
        if (converted) events.push(converted);
      }
    }
    if (turn?.status === 'ended') {
      const converted = protocol3TurnEvent(message, turn);
      if (converted) events.push(converted);
    }
    return events;
  }

  function pruneTurn(agentId, turnId) {
    const prefix = `${agentId}\0${turnId}\0`;
    for (const key of timingByStep.keys()) {
      if (key.startsWith(prefix)) timingByStep.delete(key);
    }
    for (const key of itemTypes.keys()) {
      if (key.startsWith(prefix)) itemTypes.delete(key);
    }
    for (const key of timingHintsByStep.keys()) {
      if (key.startsWith(prefix)) timingHintsByStep.delete(key);
    }
  }

  function events(message) {
    if (!message || typeof message !== 'object') return [];
    const agentId = message.agent_id || 'main';
    if (message.type === 'agent') {
      if (typeof message.model === 'string' && message.model) {
        rememberBounded(modelsByAgent, agentId, message.model);
      }
      return [event(message, agentId, 'agent.status.updated', {
        status: message.status,
        model: message.model
      })];
    }
    if (message.type === 'task.list') {
      for (const task of message.tasks || []) noteTask(task);
      return [];
    }
    if (message.type === 'task') {
      noteTask(message);
      const childId = message.child_agent_id;
      if (!childId) return [];
      const type = message.status === 'running'
        ? 'subagent.started'
        : message.outcome === 'completed' ? 'subagent.completed' : 'subagent.failed';
      return [event(message, agentId, type, { subagentId: childId })];
    }
    if (message.type === 'turns') {
      return (message.turns || []).flatMap((turn) => protocol3TurnEvents(message, turn, true));
    }
    if (message.type === 'turn.updated') {
      const converted = protocol3StepEvent(message, message.turn_id, message.step);
      return converted ? [converted] : [];
    }
    if (message.type === 'turn.started') {
      noteTurn(message, message.turn);
      const converted = protocol3TurnEvent(message, message.turn);
      return converted ? [converted] : [];
    }
    if (message.type === 'turn.ended') {
      return protocol3TurnEvents(message, message.turn, true);
    }
    if (message.type === 'item.started' || message.type === 'item.ended') {
      noteItem(message, message.turn_id, message.item);
      if (message.item?.type !== 'tool_call') return [];
      return [event(
        message,
        agentId,
        message.type === 'item.started' ? 'tool.call.started' : 'tool.result',
        {}
      )];
    }
    if (message.type === 'item.delta') {
      const itemType = itemTypes.get(protocol3StepKey(agentId, message.turn_id, message.item_id));
      if (itemType === 'reasoning') return [event(message, agentId, 'thinking.delta', {})];
      if (itemType === 'assistant_message') return [event(message, agentId, 'assistant.delta', {})];
      return [];
    }
    if (message.type === 'turns.removed') {
      for (const turnId of message.turn_ids || []) pruneTurn(agentId, turnId);
      return [];
    }
    if (message.type === 'session_event' && message.payload && typeof message.payload === 'object') {
      return [{
        ...message.payload,
        session_id: message.session_id,
        timestamp: message.timestamp,
        kcmTranscript: true
      }];
    }
    return [];
  }

  return { events, subscribedAgentIds: () => [...agentIds] };
}
