import assert from 'node:assert/strict';
import type { AgentEvent, AgentMessage } from '../client/src/api/agent-events';
import { buildTranscriptFromHistory } from '../client/src/lib/transcript';

const messages: AgentMessage[] = [
  { ts: '2026-05-30T10:00:00.000Z', role: 'user', text: 'Hello' },
  { ts: '2026-05-30T10:00:05.000Z', role: 'assistant', text: 'Hi there' },
];

const events: AgentEvent[] = [
  {
    seq: 1,
    ts: '2026-05-30T10:00:01.000Z',
    type: 'assistant.delta',
    payload: { text: 'Hi ' },
  },
  {
    seq: 2,
    ts: '2026-05-30T10:00:02.000Z',
    type: 'assistant.delta',
    payload: { text: 'there' },
  },
  {
    seq: 3,
    ts: '2026-05-30T10:00:03.000Z',
    type: 'assistant.message',
    payload: { text: 'Hi there' },
  },
];

const entries = buildTranscriptFromHistory(messages, events);
const assistantEntries = entries.filter((e) => e.role === 'assistant');

assert.equal(
  assistantEntries.length,
  1,
  `expected one assistant entry, got ${assistantEntries.length}: ${JSON.stringify(entries)}`,
);
assert.equal(assistantEntries[0]?.text, 'Hi there');

const shortSnapshotEvents: AgentEvent[] = [
  {
    seq: 1,
    ts: '2026-05-30T10:00:01.000Z',
    type: 'assistant.delta',
    payload: { text: 'Hello ' },
  },
  {
    seq: 2,
    ts: '2026-05-30T10:00:02.000Z',
    type: 'assistant.delta',
    payload: { text: 'world' },
  },
  {
    seq: 3,
    ts: '2026-05-30T10:00:03.000Z',
    type: 'assistant.message',
    payload: { text: 'Hello' },
  },
];

const shortSnapshotEntries = buildTranscriptFromHistory(
  [{ ts: '2026-05-30T10:00:00.000Z', role: 'user', text: 'Hi' }],
  shortSnapshotEvents,
);
assert.equal(
  shortSnapshotEntries.find((e) => e.role === 'assistant')?.text,
  'Hello world',
  'short assistant.message must not truncate longer streamed text',
);

const twoTurnMessages: AgentMessage[] = [
  { ts: '2026-05-30T10:00:00.000Z', role: 'user', text: 'First' },
  { ts: '2026-05-30T10:00:05.000Z', role: 'assistant', text: 'Reply one' },
  { ts: '2026-05-30T10:01:00.000Z', role: 'user', text: 'Second' },
  { ts: '2026-05-30T10:01:05.000Z', role: 'assistant', text: 'Reply two' },
];

const twoTurnEvents: AgentEvent[] = [
  {
    seq: 1,
    ts: '2026-05-30T10:00:02.000Z',
    type: 'assistant.message',
    payload: { text: 'Reply one' },
  },
  {
    seq: 2,
    ts: '2026-05-30T10:01:02.000Z',
    type: 'assistant.message',
    payload: { text: 'Reply two' },
  },
];

const twoTurnEntries = buildTranscriptFromHistory(twoTurnMessages, twoTurnEvents);
assert.equal(
  twoTurnEntries.filter((e) => e.role === 'assistant').length,
  2,
  'each turn should have one assistant entry from events',
);
assert.equal(
  twoTurnEntries.filter((e) => e.role === 'user').length,
  2,
  'user messages should still be present',
);

const messagesOnly = buildTranscriptFromHistory(twoTurnMessages, []);
assert.equal(
  messagesOnly.filter((e) => e.role === 'assistant').length,
  2,
  'without events, assistant messages should come from persisted messages',
);

// Mid-turn finalize then more deltas must not create overlapping bubbles.
const midTurnFinalizeEvents: AgentEvent[] = [
  {
    seq: 1,
    ts: '2026-05-30T10:00:01.000Z',
    type: 'assistant.delta',
    payload: { text: 'Hello' },
  },
  {
    seq: 2,
    ts: '2026-05-30T10:00:02.000Z',
    type: 'assistant.message',
    payload: { text: 'Hello' },
  },
  {
    seq: 3,
    ts: '2026-05-30T10:00:03.000Z',
    type: 'assistant.delta',
    payload: { text: ' world' },
  },
  {
    seq: 4,
    ts: '2026-05-30T10:00:04.000Z',
    type: 'assistant.message',
    payload: { text: 'Hello world' },
  },
];

const midTurnEntries = buildTranscriptFromHistory(
  [{ ts: '2026-05-30T10:00:00.000Z', role: 'user', text: 'Hi' }],
  midTurnFinalizeEvents,
);
const midTurnAssistants = midTurnEntries.filter((e) => e.role === 'assistant');
assert.equal(
  midTurnAssistants.length,
  1,
  `mid-turn finalize must keep one assistant bubble, got ${midTurnAssistants.length}`,
);
assert.equal(midTurnAssistants[0]?.text, 'Hello world');

// Tool gap: continue streaming into the open assistant bubble, not a new one.
const toolGapEvents: AgentEvent[] = [
  {
    seq: 1,
    ts: '2026-05-30T10:00:01.000Z',
    type: 'assistant.delta',
    payload: { text: 'Before tool' },
  },
  {
    seq: 2,
    ts: '2026-05-30T10:00:02.000Z',
    type: 'tool.start',
    payload: {
      tool: { callId: 'c1', name: 'bash', status: 'running', title: 'bash' },
    },
  },
  {
    seq: 3,
    ts: '2026-05-30T10:00:03.000Z',
    type: 'tool.end',
    payload: {
      tool: { callId: 'c1', name: 'bash', status: 'completed', title: 'bash' },
    },
  },
  {
    seq: 4,
    ts: '2026-05-30T10:00:04.000Z',
    type: 'assistant.delta',
    payload: { text: ' after tool' },
  },
  {
    seq: 5,
    ts: '2026-05-30T10:00:05.000Z',
    type: 'assistant.message',
    payload: { text: 'Before tool after tool' },
  },
];

const toolGapEntries = buildTranscriptFromHistory(
  [{ ts: '2026-05-30T10:00:00.000Z', role: 'user', text: 'Run' }],
  toolGapEvents,
);
const toolGapAssistants = toolGapEntries.filter((e) => e.role === 'assistant');
assert.equal(
  toolGapAssistants.length,
  1,
  'deltas after tools must append to the open streaming assistant',
);
assert.equal(toolGapAssistants[0]?.text, 'Before tool after tool');

// Replace deltas must not concatenate the full snapshot onto prior text.
const replaceEvents: AgentEvent[] = [
  {
    seq: 1,
    ts: '2026-05-30T10:00:01.000Z',
    type: 'assistant.delta',
    payload: { text: 'Hello' },
  },
  {
    seq: 2,
    ts: '2026-05-30T10:00:02.000Z',
    type: 'assistant.delta',
    payload: { text: 'Goodbye', replace: true },
  },
];

const replaceEntries = buildTranscriptFromHistory(
  [{ ts: '2026-05-30T10:00:00.000Z', role: 'user', text: 'Hi' }],
  replaceEvents,
);
assert.equal(
  replaceEntries.find((e) => e.role === 'assistant')?.text,
  'Goodbye',
  'replace delta must overwrite bubble text',
);

console.log('verify-transcript-history: ok');
