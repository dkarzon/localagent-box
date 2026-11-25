import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createOpenCodeEventMapper } from './event-mapper';
import type { OpenCodeServerEvent } from './session-runner';
import {
  createOpenCodeV2EventAdapter,
  parseV2SseDataLine,
  streamPartId,
  type OpenCodeV2Event,
} from './v2-event-adapter';

const SID = 'ses_test';
const MSG = 'msg_assistant1';

function ev(type: string, data: Record<string, unknown>, created = 1000): OpenCodeV2Event {
  return { id: `evt_${type}`, created, type, data };
}

function translateAll(events: OpenCodeV2Event[]): OpenCodeServerEvent[] {
  const adapter = createOpenCodeV2EventAdapter();
  return events.flatMap((e) => adapter.translate(e));
}

/** A successful turn built from the payload shapes in docs/opencodeapi.v2.json. */
const successfulTurn: OpenCodeV2Event[] = [
  ev('session.execution.started', { sessionID: SID }),
  ev('session.step.started', {
    sessionID: SID,
    assistantMessageID: MSG,
    agent: 'build',
    model: { id: 'gemma4:e4b', providerID: 'ollama' },
    started: 1,
  }),
  ev('session.reasoning.started', { sessionID: SID, assistantMessageID: MSG, ordinal: 0 }),
  ev('session.reasoning.delta', { sessionID: SID, assistantMessageID: MSG, ordinal: 0, delta: 'Thinking' }),
  ev('session.reasoning.ended', { sessionID: SID, assistantMessageID: MSG, ordinal: 0, text: 'Thinking' }),
  ev('session.tool.input.started', { sessionID: SID, assistantMessageID: MSG, id: 'call_1', name: 'shell' }),
  ev('session.tool.called', {
    sessionID: SID,
    assistantMessageID: MSG,
    id: 'call_1',
    input: { command: 'ls' },
    executed: true,
  }),
  ev('session.tool.success', {
    sessionID: SID,
    assistantMessageID: MSG,
    id: 'call_1',
    content: [{ type: 'text', text: 'README.md' }],
    metadata: { title: 'List files' },
    executed: true,
  }),
  ev('session.text.started', { sessionID: SID, assistantMessageID: MSG, ordinal: 1 }),
  ev('session.text.delta', { sessionID: SID, assistantMessageID: MSG, ordinal: 1, delta: 'Hello ' }),
  ev('session.text.delta', { sessionID: SID, assistantMessageID: MSG, ordinal: 1, delta: 'world' }),
  ev('session.text.ended', { sessionID: SID, assistantMessageID: MSG, ordinal: 1, text: 'Hello world' }),
  ev(
    'session.step.ended',
    {
      sessionID: SID,
      assistantMessageID: MSG,
      finish: 'stop',
      cost: 0.0012,
      tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 7, write: 3 } },
    },
    2000,
  ),
  ev('session.execution.succeeded', { sessionID: SID }),
];

describe('createOpenCodeV2EventAdapter', () => {
  it('maps text deltas and the final snapshot onto one stable part id', () => {
    const out = translateAll(successfulTurn);
    const partId = streamPartId(MSG, 'text', 1);
    const deltas = out.filter((e) => e.type === 'message.part.delta' && e.properties.field === 'text');
    assert.deepEqual(
      deltas.map((e) => [e.properties.partID, e.properties.delta]),
      [
        [partId, 'Hello '],
        [partId, 'world'],
      ],
    );
    const snapshot = out.find(
      (e) => e.type === 'message.part.updated' && (e.properties.part as { type?: string }).type === 'text',
    );
    assert.deepEqual((snapshot?.properties.part as { id: string; text: string }).id, partId);
  });

  it('carries the tool name from input.started through to the terminal state', () => {
    const tools = translateAll(successfulTurn)
      .filter((e) => (e.properties.part as { type?: string } | undefined)?.type === 'tool')
      .map((e) => e.properties.part as { tool: string; callID: string; state: Record<string, unknown> });
    assert.deepEqual(
      tools.map((t) => [t.tool, t.callID, t.state.status]),
      [
        ['shell', 'call_1', 'pending'],
        ['shell', 'call_1', 'running'],
        ['shell', 'call_1', 'completed'],
      ],
    );
    assert.deepEqual(tools[2].state.input, { command: 'ls' });
    assert.equal(tools[2].state.output, 'README.md');
    assert.equal(tools[2].state.title, 'List files');
  });

  it('reports tool failures with the error message', () => {
    const out = translateAll([
      ev('session.tool.input.started', { sessionID: SID, assistantMessageID: MSG, id: 'c2', name: 'edit' }),
      ev('session.tool.failed', {
        sessionID: SID,
        assistantMessageID: MSG,
        id: 'c2',
        error: { type: 'tool', message: 'file not found' },
        executed: true,
      }),
    ]);
    const part = out[1].properties.part as { tool: string; state: { status: string; error: string } };
    assert.equal(part.tool, 'edit');
    assert.equal(part.state.status, 'error');
    assert.equal(part.state.error, 'file not found');
  });

  it('emits a completed assistant message with token usage and only reply text (no reasoning) on step.ended', () => {
    const msg = translateAll(successfulTurn).find((e) => e.type === 'message.updated');
    const info = msg?.properties.info as Record<string, unknown>;
    assert.equal(info.role, 'assistant');
    assert.deepEqual(info.time, { completed: 2000 });
    assert.equal(info.cost, 0.0012);
    assert.equal(info.model, 'ollama/gemma4:e4b');
    assert.deepEqual(info.tokens, { input: 100, output: 20, reasoning: 5, cache_read: 7, cache_write: 3 });
    assert.deepEqual(msg?.properties.parts, [{ type: 'text', text: 'Hello world' }]);
  });

  it('maps execution lifecycle to busy / idle status events', () => {
    const statuses = translateAll(successfulTurn)
      .filter((e) => e.type === 'session.status' || e.type === 'session.idle')
      .map((e) => (e.type === 'session.idle' ? 'idle-event' : (e.properties.status as { type: string }).type));
    assert.deepEqual(statuses, ['busy', 'idle', 'idle-event']);
  });

  it('turns execution.failed into session.error followed by idle', () => {
    const out = translateAll([
      ev('session.execution.failed', { sessionID: SID, error: { type: 'provider.auth', message: 'bad key' } }),
    ]);
    assert.deepEqual(out.map((e) => e.type), ['session.error', 'session.status', 'session.idle']);
    assert.equal((out[0].properties.error as { message: string }).message, 'bad key');
  });

  it('exposes v1 permission field names alongside the v2 ones', () => {
    const [out] = translateAll([
      ev('permission.asked', { id: 'per_1', sessionID: SID, action: 'shell', resources: ['git push *'] }),
    ]);
    assert.equal(out.type, 'permission.asked');
    assert.equal(out.properties.id, 'per_1');
    assert.equal(out.properties.sessionID, SID);
    assert.equal(out.properties.permission, 'shell');
    assert.deepEqual(out.properties.patterns, ['git push *']);
  });

  it('passes forms through and drops events with no internal equivalent', () => {
    const out = translateAll([
      ev('form.created', { form: { id: 'frm_1', sessionID: SID, title: 'Pick one', fields: [] } }),
      ev('session.inbox.enqueued', { sessionID: SID }),
      ev('filesystem.changed', {}),
    ]);
    assert.deepEqual(out.map((e) => e.type), ['form.created']);
  });

  it('feeds the existing event mapper end to end', () => {
    const mapper = createOpenCodeEventMapper();
    const mapped = translateAll(successfulTurn)
      .map((e) => mapper.map(e, SID).event)
      .filter((e): e is NonNullable<typeof e> => e !== null);

    const text = mapped
      .filter((e) => e.type === 'assistant.delta' && e.payload.field === 'text')
      .map((e) => e.payload.text)
      .join('');
    assert.equal(text, 'Hello world', 'snapshot after deltas must not duplicate text');
    assert.deepEqual(
      mapped.filter((e) => e.type.startsWith('tool.')).map((e) => e.type),
      ['tool.start', 'tool.start', 'tool.end'],
    );
    assert.equal(mapped.filter((e) => e.type === 'assistant.message').length, 1);
  });
});

describe('captured v2 stream fixture', () => {
  const fixture = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'scripts', 'fixtures', 'opencode-v2-events-retry-interrupt.sse'),
    'utf8',
  );
  const events = fixture
    .split('\n')
    .map(parseV2SseDataLine)
    .filter((e): e is OpenCodeV2Event => e !== null);

  it('parses every data frame and skips heartbeat comments', () => {
    assert.equal(events.length, 13);
    assert.equal(events[0].type, 'server.connected');
  });

  it('translates the retry / interrupt turn into busy → retry → idle', () => {
    const statuses = translateAll(events)
      .filter((e) => e.type === 'session.status')
      .map((e) => (e.properties.status as { type: string }).type);
    assert.equal(statuses[0], 'busy');
    assert.ok(statuses.includes('retry'));
    assert.equal(statuses[statuses.length - 1], 'idle');
  });
});
