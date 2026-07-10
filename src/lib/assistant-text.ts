import type { AgentEvent, AgentMessage } from '../types';

export function extractAssistantTextFromPayload(payload: Record<string, unknown>): string {
  const info = payload.info as { role?: string; content?: string; text?: string } | undefined;
  if (info?.role !== 'assistant') {
    return '';
  }
  if (typeof info?.content === 'string') {
    return info.content;
  }
  if (typeof info?.text === 'string') {
    return info.text;
  }

  const parts = payload.parts as Array<{ type?: string; text?: string }> | undefined;
  if (Array.isArray(parts)) {
    return parts
      .filter(
        (part) =>
          (part.type === 'text' || part.type === 'reasoning') && typeof part.text === 'string',
      )
      .map((part) => part.text)
      .join('\n');
  }

  if (typeof payload.text === 'string') {
    return payload.text;
  }
  return '';
}

/** Prefer the longer coherent assistant text when a final snapshot arrives. */
export function mergeAssistantText(streamed: string, snapshot: string): string {
  if (!streamed) {
    return snapshot;
  }
  if (!snapshot) {
    return streamed;
  }
  if (streamed.startsWith(snapshot) || streamed.length >= snapshot.length) {
    return streamed;
  }
  if (snapshot.startsWith(streamed)) {
    return snapshot;
  }
  return streamed.length >= snapshot.length ? streamed : snapshot;
}

export function extractAssistantSummaryFromEvents(events: AgentEvent[]): string | null {
  let streamed = '';
  let lastAssistant: string | null = null;

  for (const event of events) {
    if (event.type === 'assistant.delta') {
      const delta = typeof event.payload.text === 'string' ? event.payload.text : '';
      if (delta) {
        streamed += delta;
      }
    } else if (event.type === 'assistant.message') {
      const snapshot = extractAssistantTextFromPayload(event.payload);
      const text = mergeAssistantText(streamed, snapshot).trim();
      if (text) {
        lastAssistant = text;
      }
      streamed = '';
    }
  }

  return lastAssistant;
}

export function enrichMessagesWithAssistantFromEvents(
  messages: AgentMessage[],
  events: AgentEvent[],
): AgentMessage[] {
  const assistantCount = messages.filter(
    (message) => message.role === 'assistant' && message.text.trim(),
  ).length;
  const userCount = messages.filter(
    (message) => message.role === 'user' && message.text.trim(),
  ).length;

  if (userCount <= assistantCount && assistantCount > 0) {
    return messages;
  }

  const assistantMessages: AgentMessage[] = [];
  let streamed = '';

  for (const event of events) {
    if (event.type === 'assistant.delta') {
      const delta = typeof event.payload.text === 'string' ? event.payload.text : '';
      if (delta) {
        streamed += delta;
      }
    } else if (event.type === 'assistant.message') {
      const snapshot = extractAssistantTextFromPayload(event.payload);
      const text = mergeAssistantText(streamed, snapshot).trim();
      if (text) {
        assistantMessages.push({ ts: event.ts, role: 'assistant', text });
      }
      streamed = '';
    }
  }

  const missingAssistants = assistantMessages.slice(assistantCount);
  if (missingAssistants.length === 0) {
    return messages;
  }

  return [...messages, ...missingAssistants];
}
