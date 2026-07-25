import assert from 'node:assert/strict';
import {
  computeSnapshotTextDelta,
  createOpenCodeEventMapper,
} from '../src/integrations/opencode/event-mapper';
import type { OpenCodeServerEvent } from '../src/integrations/opencode/session-runner';

function deltaEvent(partId: string, delta: string): OpenCodeServerEvent {
  return {
    type: 'message.part.delta',
    properties: { partID: partId, field: 'text', delta },
  };
}

function updatedEvent(partId: string, text: string): OpenCodeServerEvent {
  return {
    type: 'message.part.updated',
    properties: { part: { id: partId, type: 'text', text } },
  };
}

assert.deepEqual(computeSnapshotTextDelta('', 'Hello'), {
  delta: 'Hello',
  source: 'updated-backfill',
});
assert.deepEqual(computeSnapshotTextDelta('Hello', 'Hello world'), {
  delta: ' world',
  source: 'updated-backfill',
});
assert.deepEqual(computeSnapshotTextDelta('Hello world', 'Hello world'), {
  delta: '',
  source: 'updated-skip',
});
assert.deepEqual(computeSnapshotTextDelta('Hello', 'Goodbye'), {
  delta: 'Goodbye',
  source: 'updated-reset',
});

const mapper = createOpenCodeEventMapper();

function reasoningDeltaEvent(partId: string, delta: string): OpenCodeServerEvent {
  return {
    type: 'message.part.delta',
    properties: { partID: partId, field: 'reasoning', delta },
  };
}

const first = mapper.map(deltaEvent('prt_1', 'Hel'), 'sess', 'batch');
assert.equal(first.event?.type, 'assistant.delta');
assert.equal(first.event?.payload.text, 'Hel');
assert.equal(mapper.getTextSnapshot('prt_1'), 'Hel');

const second = mapper.map(deltaEvent('prt_1', 'lo'), 'sess', 'batch');
assert.equal(second.event?.payload.text, 'lo');
assert.equal(mapper.getTextSnapshot('prt_1'), 'Hello');

const reasoning = mapper.map(reasoningDeltaEvent('prt_4', 'Think'), 'sess', 'batch');
assert.equal(reasoning.event?.payload.text, 'Think');
assert.equal(reasoning.event?.payload.field, 'reasoning');
assert.equal(reasoning.debug?.source, 'reasoning-delta');
assert.equal(mapper.getTextSnapshot('prt_4', 'reasoning'), 'Think');

mapper.reset();
const backfillOnly = mapper.map(updatedEvent('prt_2', 'Hi there'), 'sess', 'batch');
assert.equal(backfillOnly.event?.payload.text, 'Hi there');
assert.equal(backfillOnly.debug?.source, 'updated-backfill');

const backfillPartial = mapper.map(updatedEvent('prt_2', 'Hi there!'), 'sess', 'batch');
assert.equal(backfillPartial.event?.payload.text, '!');
assert.equal(backfillPartial.debug?.source, 'updated-backfill');
assert.equal(mapper.getTextSnapshot('prt_2'), 'Hi there!');

mapper.reset();
const deltaThenSnapshot = mapper.map(deltaEvent('prt_3', 'One'), 'sess', 'batch');
assert.equal(deltaThenSnapshot.event?.payload.text, 'One');
const snapshotSkip = mapper.map(updatedEvent('prt_3', 'One'), 'sess', 'batch');
assert.equal(snapshotSkip.event, null);
assert.equal(snapshotSkip.debug?.source, 'updated-skip');

mapper.reset();
const resetSnapshot = mapper.map(updatedEvent('prt_5', 'Hello'), 'sess', 'batch');
assert.equal(resetSnapshot.event?.payload.text, 'Hello');
const resetReplace = mapper.map(updatedEvent('prt_5', 'Goodbye'), 'sess', 'batch');
assert.equal(resetReplace.event?.payload.text, 'Goodbye');
assert.equal(resetReplace.event?.payload.replace, true);
assert.equal(resetReplace.debug?.source, 'updated-reset');

function messageUpdated(
  role: 'assistant' | 'user',
  completed?: number,
): OpenCodeServerEvent {
  return {
    type: 'message.updated',
    properties: {
      info: {
        role,
        time: completed == null ? { created: 1 } : { created: 1, completed },
      },
    },
  };
}

const midUpdate = mapper.map(messageUpdated('assistant'), 'sess', 'interactive');
assert.equal(midUpdate.event, null, 'incomplete message.updated must not finalize');

const userUpdate = mapper.map(messageUpdated('user', 2), 'sess', 'interactive');
assert.equal(userUpdate.event, null, 'user message.updated must be ignored');

const completedUpdate = mapper.map(messageUpdated('assistant', 2), 'sess', 'interactive');
assert.equal(completedUpdate.event?.type, 'assistant.message');

console.log('verify-event-mapper: ok');
