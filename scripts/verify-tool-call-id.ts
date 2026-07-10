import assert from 'node:assert/strict';
import { resolveToolCallId } from '../src/lib/resolve-tool-call-id';
import { normalizeToolPart } from '../src/lib/tool-event';
import { transcriptReducer } from '../client/src/lib/transcript';
import type { AgentEvent } from '../client/src/api/agent-events';

assert.equal(
  resolveToolCallId({
    type: 'tool',
    tool: 'file_edit',
    callID: 'file_edit',
    id: 'prt_first',
    state: { status: 'running' },
  }),
  'prt_first',
);

assert.equal(
  resolveToolCallId({
    type: 'tool',
    tool: 'file_edit',
    callID: 'call_unique_1',
    id: 'prt_first',
    state: { status: 'running' },
  }),
  'call_unique_1',
);

const normalized = normalizeToolPart({
  type: 'tool',
  tool: 'file_edit',
  callID: 'file_edit',
  id: 'prt_abc',
  state: { status: 'running', title: 'Edit a.ts' },
});
assert.equal(normalized?.callId, 'prt_abc');

function toolEvent(
  seq: number,
  type: 'tool.start' | 'tool.end',
  callId: string,
  name: string,
  status: 'running' | 'completed',
): AgentEvent {
  return {
    seq,
    ts: `2026-05-30T00:00:0${seq}.000Z`,
    type,
    payload: {
      tool: {
        callId,
        name,
        status,
        title: `${name} #${seq}`,
      },
    },
  };
}

let transcript = transcriptReducer([], {
  type: 'event',
  event: toolEvent(1, 'tool.start', 'file_edit', 'file_edit', 'running'),
});
transcript = transcriptReducer(transcript, {
  type: 'event',
  event: toolEvent(2, 'tool.end', 'file_edit', 'file_edit', 'completed'),
});
transcript = transcriptReducer(transcript, {
  type: 'event',
  event: toolEvent(3, 'tool.start', 'file_edit', 'file_edit', 'running'),
});

const toolEntries = transcript.filter((entry) => entry.role === 'tool');
assert.equal(toolEntries.length, 2, 'sequential same-name tools should create two entries');
assert.equal(toolEntries[0]?.toolCall?.status, 'completed');
assert.equal(toolEntries[1]?.toolCall?.status, 'running');

transcript = transcriptReducer(transcript, {
  type: 'event',
  event: toolEvent(4, 'tool.end', 'file_edit', 'file_edit', 'completed'),
});
transcript = transcriptReducer(transcript, {
  type: 'event',
  event: toolEvent(5, 'tool.end', 'file_edit', 'file_edit', 'completed'),
});
const afterDuplicateEnd = transcript.filter((entry) => entry.role === 'tool');
assert.equal(afterDuplicateEnd.length, 2, 'duplicate tool.end should update in place');

console.log('verify-tool-call-id: ok');
