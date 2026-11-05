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
    timestamp: message.timestamp,
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
