import {
  extractAssistantText,
  extractToolFromPayload,
  type AgentEvent,
  type AgentMessage,
  type TranscriptEntry,
  type TranscriptToolCall,
} from '../api/agent-events';
import { formatToolValue } from './format-tool';

export function messagesToEntries(
  messages: AgentMessage[],
  indexOffset = 0,
): TranscriptEntry[] {
  return messages.map((message, index) => ({
    id: `msg-${indexOffset + index}-${message.ts}`,
    role: message.role,
    text: message.text,
    ts: message.ts,
  }));
}

function mapToolStatus(
  status: ReturnType<typeof extractToolFromPayload>['status'],
): TranscriptToolCall['status'] {
  if (status === 'completed') {
    return 'completed';
  }
  if (status === 'error') {
    return 'error';
  }
  return 'running';
}

function findToolEntryIndex(
  state: TranscriptEntry[],
  callId: string,
  eventType: 'tool.start' | 'tool.end',
): number {
  for (let i = state.length - 1; i >= 0; i -= 1) {
    const entry = state[i];
    if (entry?.role === 'tool' && entry.toolCall?.id === callId && entry.toolCall.status === 'running') {
      return i;
    }
  }

  if (eventType === 'tool.end') {
    for (let i = state.length - 1; i >= 0; i -= 1) {
      const entry = state[i];
      if (entry?.role === 'tool' && entry.toolCall?.id === callId) {
        return i;
      }
    }
  }

  return -1;
}

/** Latest assistant bubble — tools may sit after it while the turn is still open. */
function findLastAssistantIndex(state: TranscriptEntry[], streamingOnly = false): number {
  for (let i = state.length - 1; i >= 0; i -= 1) {
    const entry = state[i];
    if (entry?.role === 'assistant' && (!streamingOnly || entry.streaming)) {
      return i;
    }
  }
  return -1;
}

function buildToolCall(
  tool: ReturnType<typeof extractToolFromPayload>,
  eventTs: string,
  existing?: TranscriptToolCall,
): TranscriptToolCall {
  const running = tool.status === 'pending' || tool.status === 'running';
  return {
    id: tool.callId,
    name: tool.name,
    status: running ? 'running' : mapToolStatus(tool.status),
    startedAt: existing?.startedAt || eventTs,
    endedAt: running ? existing?.endedAt : eventTs,
    title: tool.title || existing?.title,
    input: formatToolValue(tool.input) ?? existing?.input,
    output: tool.output ?? existing?.output,
    error: tool.error ?? existing?.error,
  };
}

export type TranscriptAction =
  | { type: 'reset'; entries: TranscriptEntry[] }
  | { type: 'append_user'; text: string; ts: string }
  | { type: 'event'; event: AgentEvent };

/** Prefer the longer coherent assistant text when a final snapshot arrives. */
export function mergeAssistantText(streamed: string, snapshot: string): string {
  if (!streamed) return snapshot;
  if (!snapshot) return streamed;
  // Delta+updated double-emit produces the final text twice in the stream.
  if (streamed === snapshot + snapshot) {
    return snapshot;
  }
  if (streamed.startsWith(snapshot) || streamed.length >= snapshot.length) {
    return streamed;
  }
  if (snapshot.startsWith(streamed)) {
    return snapshot;
  }
  return streamed.length >= snapshot.length ? streamed : snapshot;
}

/**
 * Repair exact full-text duplication when assistant.message has no usable snapshot
 * (common for OpenCode message.updated payloads without parts).
 * Only collapses substantial blobs to avoid eating short intentional repeats.
 */
export function collapseExactDuplicatedText(text: string, minHalfLength = 80): string {
  if (text.length < minHalfLength * 2 || text.length % 2 !== 0) {
    return text;
  }
  const half = text.length / 2;
  const first = text.slice(0, half);
  if (first === text.slice(half)) {
    return first;
  }
  return text;
}

export function transcriptReducer(state: TranscriptEntry[], action: TranscriptAction): TranscriptEntry[] {
  switch (action.type) {
    case 'reset':
      return action.entries;
    case 'append_user':
      return [
        ...state,
        {
          id: `local-user-${action.ts}`,
          role: 'user',
          text: action.text,
          ts: action.ts,
        },
      ];
    case 'event': {
      const { event } = action;
      switch (event.type) {
        case 'assistant.delta': {
          // Reasoning streams into the same bubble otherwise, and thinking models
          // often echo the final answer there — hide it from the conversation view.
          if (event.payload.field === 'reasoning') {
            return state;
          }
          const delta = typeof event.payload.text === 'string' ? event.payload.text : '';
          if (!delta) return state;
          const replace = event.payload.replace === true;

          // Continue the open stream, or the latest assistant when it is still
          // the tail entry (defense if a premature finalize closed it).
          const streamingIdx = findLastAssistantIndex(state, true);
          const idx =
            streamingIdx >= 0
              ? streamingIdx
              : state[state.length - 1]?.role === 'assistant'
                ? state.length - 1
                : -1;
          if (idx >= 0) {
            const entry = state[idx]!;
            const next = [...state];
            next[idx] = {
              ...entry,
              text: replace ? delta : entry.text + delta,
              ts: event.ts,
              streaming: true,
            };
            return next;
          }

          return [
            ...state,
            {
              id: `assistant-stream-${event.seq}`,
              role: 'assistant',
              text: delta,
              ts: event.ts,
              streaming: true,
            },
          ];
        }
        case 'assistant.message': {
          const text = extractAssistantText(event.payload);
          // Prefer the open streaming bubble; otherwise only merge if the
          // latest entry is still an assistant (not a tool gap → new step).
          const streamingIdx = findLastAssistantIndex(state, true);
          const idx =
            streamingIdx >= 0
              ? streamingIdx
              : state[state.length - 1]?.role === 'assistant'
                ? state.length - 1
                : -1;
          if (idx >= 0) {
            const entry = state[idx]!;
            const next = [...state];
            next[idx] = {
              ...entry,
              text: collapseExactDuplicatedText(mergeAssistantText(entry.text, text)),
              ts: event.ts,
              streaming: false,
            };
            return next;
          }
          if (!text) return state;
          return [
            ...state,
            {
              id: `assistant-${event.seq}`,
              role: 'assistant',
              text: collapseExactDuplicatedText(text),
              ts: event.ts,
              streaming: false,
            },
          ];
        }
        case 'tool.start':
        case 'tool.end': {
          const tool = extractToolFromPayload(event.payload);
          const toolCall = buildToolCall(tool, event.ts);

          const matchIndex = findToolEntryIndex(state, tool.callId, event.type);
          if (matchIndex >= 0) {
            const entry = state[matchIndex]!;
            const next = [...state];
            next[matchIndex] = {
              ...entry,
              text: tool.title || entry.text,
              ts: event.ts,
              toolCall: buildToolCall(tool, event.ts, entry.toolCall),
            };
            return next;
          }

          return [
            ...state,
            {
              id: `tool-${tool.callId}`,
              role: 'tool',
              text: tool.title || tool.name,
              ts: event.ts,
              toolCall,
            },
          ];
        }
        default:
          return state;
      }
    }
    default:
      return state;
  }
}

function nextUserMessageTs(messages: AgentMessage[], afterIndex: number): string | undefined {
  for (let i = afterIndex + 1; i < messages.length; i += 1) {
    const message = messages[i];
    if (message?.role === 'user') {
      return message.ts;
    }
  }
  return undefined;
}

export function buildTranscriptFromHistory(
  messages: AgentMessage[],
  events: AgentEvent[],
): TranscriptEntry[] {
  if (events.length === 0) {
    return messagesToEntries(messages);
  }

  let entries: TranscriptEntry[] = [];
  let eventIndex = 0;

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!;
    if (message.role !== 'user') {
      continue;
    }

    entries = [...entries, ...messagesToEntries([message], i)];

    const nextUserTs = nextUserMessageTs(messages, i);
    while (eventIndex < events.length) {
      const event = events[eventIndex]!;
      if (nextUserTs && event.ts >= nextUserTs) {
        break;
      }
      entries = transcriptReducer(entries, { type: 'event', event });
      eventIndex += 1;
    }
  }

  while (eventIndex < events.length) {
    entries = transcriptReducer(entries, { type: 'event', event: events[eventIndex]! });
    eventIndex += 1;
  }

  return entries;
}
