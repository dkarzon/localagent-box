/**
 * Translates OpenCode v2 SSE events (`GET /api/event`) into the v1-shaped
 * `{ type, properties }` events that `event-mapper.ts` and the orchestrator consume.
 *
 * Keeping the internal event vocabulary stable means persisted transcripts from v1 runs
 * still render, and the mapper / UI need no changes. Payload shapes: docs/opencodeapi.v2.json.
 */
import type { OpenCodeServerEvent } from './session-runner';

/** v2 SSE envelope. `durable` is present on events persisted to the session log. */
export interface OpenCodeV2Event {
  id?: string;
  created?: number;
  type: string;
  location?: { directory?: string };
  metadata?: Record<string, unknown>;
  data?: Record<string, unknown>;
  durable?: { aggregateID: string; seq: number; version: number };
}

interface V2Error {
  type?: string;
  message?: string;
}

interface V2Tokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

interface ToolState {
  name: string;
  input?: unknown;
  messageID: string;
}

interface StepState {
  model?: { id?: string; providerID?: string };
  parts: Array<{ type: 'text'; text: string }>;
}

export interface OpenCodeV2EventAdapter {
  translate: (event: OpenCodeV2Event) => OpenCodeServerEvent[];
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Tool result content is `[{type:'text', text}, {type:'file', ...}]`; keep the text. */
function toolContentToText(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .map((item) => (item && typeof item === 'object' ? str((item as { text?: unknown }).text) : undefined))
    .filter((t): t is string => typeof t === 'string')
    .join('\n');
  return text || undefined;
}

export function streamPartId(messageID: string, field: 'text' | 'reasoning', ordinal: unknown): string {
  return `${messageID}:${field}:${typeof ordinal === 'number' ? ordinal : 0}`;
}

export function createOpenCodeV2EventAdapter(): OpenCodeV2EventAdapter {
  const tools = new Map<string, ToolState>();
  const steps = new Map<string, StepState>();

  function step(messageID: string): StepState {
    let state = steps.get(messageID);
    if (!state) {
      state = { parts: [] };
      steps.set(messageID, state);
    }
    return state;
  }

  function toolPart(
    id: string,
    sessionID: string | undefined,
    state: Record<string, unknown>,
  ): OpenCodeServerEvent {
    const tool = tools.get(id);
    return {
      type: 'message.part.updated',
      properties: {
        sessionID,
        part: {
          id,
          type: 'tool',
          tool: tool?.name ?? 'tool',
          callID: id,
          sessionID,
          messageID: tool?.messageID,
          state: { input: tool?.input, ...state },
        },
      },
    };
  }

  function idle(sessionID: string | undefined): OpenCodeServerEvent[] {
    return [
      { type: 'session.status', properties: { sessionID, status: { type: 'idle' } } },
      { type: 'session.idle', properties: { sessionID } },
    ];
  }

  function translate(event: OpenCodeV2Event): OpenCodeServerEvent[] {
    const data = event.data ?? {};
    const sessionID = str(data.sessionID);
    const messageID = str(data.assistantMessageID) ?? '';

    switch (event.type) {
      case 'server.connected':
        return [{ type: 'server.connected', properties: {} }];

      // --- streamed text / reasoning ------------------------------------------------
      case 'session.text.delta':
      case 'session.reasoning.delta': {
        const field = event.type === 'session.text.delta' ? 'text' : 'reasoning';
        const delta = str(data.delta);
        if (!delta) return [];
        return [
          {
            type: 'message.part.delta',
            properties: {
              sessionID,
              messageID,
              partID: streamPartId(messageID, field, data.ordinal),
              field,
              delta,
            },
          },
        ];
      }
      case 'session.text.ended':
      case 'session.reasoning.ended': {
        const field = event.type === 'session.text.ended' ? 'text' : 'reasoning';
        const text = str(data.text) ?? '';
        // Only reply text goes on the step's assistant message — that payload feeds the
        // conversation log, which must not record the model's thinking (v1 never sent it).
        if (field === 'text') {
          step(messageID).parts.push({ type: 'text', text });
        }
        return [
          {
            type: 'message.part.updated',
            properties: {
              sessionID,
              part: {
                id: streamPartId(messageID, field, data.ordinal),
                type: field,
                text,
                sessionID,
                messageID,
              },
            },
          },
        ];
      }

      // --- tools ------------------------------------------------------------------
      case 'session.tool.input.started': {
        const id = str(data.id);
        if (!id) return [];
        tools.set(id, { name: str(data.name) ?? 'tool', messageID });
        return [toolPart(id, sessionID, { status: 'pending' })];
      }
      case 'session.tool.called': {
        const id = str(data.id);
        if (!id) return [];
        const existing = tools.get(id);
        tools.set(id, { name: existing?.name ?? 'tool', messageID, input: data.input });
        return [toolPart(id, sessionID, { status: 'running' })];
      }
      case 'session.tool.success': {
        const id = str(data.id);
        if (!id) return [];
        const metadata = data.metadata as Record<string, unknown> | undefined;
        const out = toolPart(id, sessionID, {
          status: 'completed',
          output: toolContentToText(data.content),
          ...(metadata ? { metadata } : {}),
          ...(typeof metadata?.title === 'string' ? { title: metadata.title } : {}),
        });
        tools.delete(id);
        return [out];
      }
      case 'session.tool.failed': {
        const id = str(data.id);
        if (!id) return [];
        const error = data.error as V2Error | undefined;
        const out = toolPart(id, sessionID, {
          status: 'error',
          error: error?.message ?? error?.type ?? 'Tool failed',
          output: toolContentToText(data.content),
        });
        tools.delete(id);
        return [out];
      }

      // --- steps (one assistant message per step, carrying token usage) ------------
      case 'session.step.started': {
        const state = step(messageID);
        state.model = data.model as StepState['model'];
        return [];
      }
      case 'session.step.ended':
      case 'session.step.failed': {
        const state = steps.get(messageID) ?? { parts: [] };
        steps.delete(messageID);
        const tokens = data.tokens as V2Tokens | undefined;
        const model = state.model
          ? `${state.model.providerID ?? ''}/${state.model.id ?? ''}`
          : undefined;
        const info: Record<string, unknown> = {
          id: messageID,
          role: 'assistant',
          sessionID,
          time: { completed: event.created ?? Date.now() },
          ...(typeof data.cost === 'number' ? { cost: data.cost } : {}),
          ...(model ? { model } : {}),
          ...(typeof data.finish === 'string' ? { finish: data.finish } : {}),
          ...(tokens
            ? {
                tokens: {
                  input: tokens.input ?? 0,
                  output: tokens.output ?? 0,
                  reasoning: tokens.reasoning ?? 0,
                  cache_read: tokens.cache?.read ?? 0,
                  cache_write: tokens.cache?.write ?? 0,
                },
              }
            : {}),
          ...(event.type === 'session.step.failed' ? { error: data.error } : {}),
        };
        return [{ type: 'message.updated', properties: { info, parts: state.parts } }];
      }

      // --- turn lifecycle -----------------------------------------------------------
      case 'session.execution.started':
        return [{ type: 'session.status', properties: { sessionID, status: { type: 'busy' } } }];
      case 'session.execution.succeeded':
        return idle(sessionID);
      case 'session.execution.interrupted':
        return idle(sessionID);
      case 'session.execution.failed': {
        const error = data.error as V2Error | undefined;
        return [
          {
            type: 'session.error',
            properties: {
              sessionID,
              error: { name: error?.type ?? 'ExecutionFailed', message: error?.message ?? 'Execution failed', data: error },
            },
          },
          ...idle(sessionID),
        ];
      }
      case 'session.retry.scheduled': {
        const error = data.error as V2Error | undefined;
        return [
          {
            type: 'session.status',
            properties: {
              sessionID,
              status: { type: 'retry', attempt: data.attempt, message: error?.message, next: data.at },
            },
          },
        ];
      }
      case 'session.status':
      case 'session.idle':
        return [{ type: event.type, properties: data }];
      case 'session.created':
        return [{ type: 'session.created', properties: { sessionID, info: data } }];

      // --- permissions / forms ------------------------------------------------------
      case 'permission.asked':
        return [
          {
            type: 'permission.asked',
            properties: {
              ...data,
              // v1 field names, still read by the UI permission card.
              permission: data.action,
              patterns: data.resources,
            },
          },
        ];
      case 'permission.replied':
        return [{ type: 'permission.replied', properties: data }];
      case 'form.created':
      case 'form.replied':
      case 'form.cancelled':
        return [{ type: event.type, properties: data }];

      default:
        return [];
    }
  }

  return { translate };
}

/** Parse one SSE `data:` line into a v2 envelope (null for comments / malformed lines). */
export function parseV2SseDataLine(line: string): OpenCodeV2Event | null {
  const prefix = 'data: ';
  const trimmed = line.trim();
  if (!trimmed.startsWith(prefix)) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed.slice(prefix.length)) as OpenCodeV2Event;
    return typeof parsed?.type === 'string' ? parsed : null;
  } catch {
    return null;
  }
}
