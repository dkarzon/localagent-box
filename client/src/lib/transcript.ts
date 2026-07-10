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
  if (streamed.startsWith(snapshot) || streamed.length >= snapshot.length) {
    return streamed;
  }
  if (snapshot.startsWith(streamed)) {
    return snapshot;
  }
  return streamed.length >= snapshot.length ? streamed : snapshot;
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
          const delta = typeof event.payload.text === 'string' ? event.payload.text : '';
          if (!delta) return state;

          const last = state[state.length - 1];
          if (last?.role === 'assistant' && last.streaming) {
            return [
              ...state.slice(0, -1),
              { ...last, text: last.text + delta, ts: event.ts },
            ];
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
          const last = state[state.length - 1];
          if (last?.role === 'assistant') {
            return [
              ...state.slice(0, -1),
              {
                ...last,
                text: mergeAssistantText(last.text, text),
                ts: event.ts,
                streaming: false,
              },
            ];
          }
          if (!text) return state;
          return [
            ...state,
            {
              id: `assistant-${event.seq}`,
              role: 'assistant',
              text,
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
