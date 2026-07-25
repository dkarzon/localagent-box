import { isTerminalToolStatus, normalizeToolPart } from '../../lib/tool-event';
import type { AgentEventType, AgentStatus } from '../../types';
import type { OpenCodeServerEvent } from './session-runner';

export type AgentRunMode = 'batch' | 'interactive';

export interface MappedOpenCodeEvent {
  type: AgentEventType;
  payload: Record<string, unknown>;
  status?: AgentStatus;
}

export type TextStreamField = 'text' | 'reasoning';

export interface OpenCodeEventMapperDebug {
  partId?: string;
  source?:
    | 'delta'
    | 'reasoning-delta'
    | 'reasoning-updated-backfill'
    | 'reasoning-updated-skip'
    | 'reasoning-updated-reset'
    | 'updated-backfill'
    | 'updated-skip'
    | 'updated-reset';
  field?: TextStreamField;
  previousLen?: number;
  nextLen?: number;
  emittedLen?: number;
  deltaLen?: number;
  preview?: string;
}

export interface OpenCodeEventMapperResult {
  event: MappedOpenCodeEvent | null;
  debug?: OpenCodeEventMapperDebug;
}

/** Compute incremental text to emit when a full snapshot arrives. */
export function computeSnapshotTextDelta(previous: string, next: string): {
  delta: string;
  source: 'updated-backfill' | 'updated-skip' | 'updated-reset';
} {
  if (next === previous) {
    return { delta: '', source: 'updated-skip' };
  }
  if (next.startsWith(previous)) {
    return { delta: next.slice(previous.length), source: 'updated-backfill' };
  }
  return { delta: next, source: 'updated-reset' };
}

function readPartId(properties: Record<string, unknown>): string | undefined {
  if (typeof properties.partID === 'string') {
    return properties.partID;
  }
  const part = properties.part as { id?: string } | undefined;
  return typeof part?.id === 'string' ? part.id : undefined;
}

function readTextPart(
  event: OpenCodeServerEvent,
): { partId?: string; text: string; field: TextStreamField } | null {
  if (event.type === 'message.part.updated') {
    const part = event.properties.part as { id?: string; type?: string; text?: string } | undefined;
    if (
      (part?.type === 'text' || part?.type === 'reasoning') &&
      typeof part.text === 'string'
    ) {
      return {
        partId: part.id,
        text: part.text,
        field: part.type === 'reasoning' ? 'reasoning' : 'text',
      };
    }
    return null;
  }

  if (event.type === 'message.part.delta') {
    const rawField = event.properties.field;
    if (rawField && rawField !== 'text' && rawField !== 'reasoning') {
      return null;
    }
    const field: TextStreamField = rawField === 'reasoning' ? 'reasoning' : 'text';
    const delta = event.properties.delta;
    if (typeof delta !== 'string' || !delta) {
      return null;
    }
    return { partId: readPartId(event.properties), text: delta, field };
  }

  return null;
}

function snapshotSourceForField(
  field: TextStreamField,
  source: 'updated-backfill' | 'updated-skip' | 'updated-reset',
): OpenCodeEventMapperDebug['source'] {
  if (field === 'reasoning') {
    if (source === 'updated-backfill') return 'reasoning-updated-backfill';
    if (source === 'updated-skip') return 'reasoning-updated-skip';
    return 'reasoning-updated-reset';
  }
  return source;
}

function snapshotKey(partId: string, field: TextStreamField): string {
  return `${partId}:${field}`;
}

function mapToolPartEvent(event: OpenCodeServerEvent): MappedOpenCodeEvent | null {
  const part = event.properties.part as {
    type?: string;
    tool?: string;
    state?: string;
  } | undefined;
  if (part?.type !== 'tool') {
    return null;
  }
  const tool = normalizeToolPart(part as Record<string, unknown>);
  if (!tool) {
    return null;
  }
  const isEnd = isTerminalToolStatus(tool.status);
  return {
    type: isEnd ? 'tool.end' : 'tool.start',
    payload: { tool, part },
  };
}

function mapStatusEvent(
  event: OpenCodeServerEvent,
  mode: AgentRunMode,
): MappedOpenCodeEvent | null {
  switch (event.type) {
    case 'session.status': {
      const statusObj = event.properties.status as { type?: string } | undefined;
      const statusType = statusObj?.type;
      if (statusType === 'busy') {
        return { type: 'session.status', payload: { status: 'busy' }, status: 'processing' };
      }
      if (statusType === 'idle') {
        const mapped: MappedOpenCodeEvent = {
          type: 'session.status',
          payload: { status: 'idle' },
        };
        if (mode === 'interactive') {
          mapped.status = 'awaiting_input';
        }
        return mapped;
      }
      return { type: 'session.status', payload: { raw: event.properties } };
    }
    case 'session.idle': {
      const mapped: MappedOpenCodeEvent = {
        type: 'session.status',
        payload: { status: 'idle' },
      };
      if (mode === 'interactive') {
        mapped.status = 'awaiting_input';
      }
      return mapped;
    }
    default:
      return null;
  }
}

export interface OpenCodeEventMapper {
  map: (event: OpenCodeServerEvent, sessionId: string, mode: AgentRunMode) => OpenCodeEventMapperResult;
  reset: () => void;
  getTextSnapshot: (partId: string) => string | undefined;
}

/** Stateful mapper — tracks per-part text snapshots for delta + backfill. */
export function createOpenCodeEventMapper(): OpenCodeEventMapper {
  const textSnapshots = new Map<string, string>();

  function mapTextDelta(
    partId: string,
    delta: string,
    field: TextStreamField,
    source: OpenCodeEventMapperDebug['source'],
  ): OpenCodeEventMapperResult {
    const key = snapshotKey(partId, field);
    const previous = textSnapshots.get(key) ?? '';
    const isIncrementalDelta = source === 'delta' || source === 'reasoning-delta';
    const next = isIncrementalDelta ? previous + delta : delta;
    textSnapshots.set(key, next);

    if (!delta) {
      return {
        event: null,
        debug: {
          partId,
          source,
          field,
          previousLen: previous.length,
          nextLen: next.length,
          emittedLen: 0,
          deltaLen: 0,
        },
      };
    }

    return {
      event: { type: 'assistant.delta', payload: { text: delta, partId, field } },
      debug: {
        partId,
        source,
        field,
        previousLen: previous.length,
        nextLen: next.length,
        emittedLen: delta.length,
        deltaLen: delta.length,
        preview: delta.slice(0, 80),
      },
    };
  }

  function map(event: OpenCodeServerEvent, _sessionId: string, mode: AgentRunMode): OpenCodeEventMapperResult {
    switch (event.type) {
      case 'server.connected':
        return { event: null };
      case 'message.part.delta': {
        const textPart = readTextPart(event);
        if (!textPart) {
          return { event: null };
        }
        const partId = textPart.partId ?? 'unknown';
        const source = textPart.field === 'reasoning' ? 'reasoning-delta' : 'delta';
        return mapTextDelta(partId, textPart.text, textPart.field, source);
      }
      case 'message.part.updated': {
        const toolMapped = mapToolPartEvent(event);
        if (toolMapped) {
          return { event: toolMapped };
        }

        const textPart = readTextPart(event);
        if (!textPart) {
          return { event: null };
        }

        const partId = textPart.partId ?? 'unknown';
        const key = snapshotKey(partId, textPart.field);
        const previous = textSnapshots.get(key) ?? '';
        const { delta, source } = computeSnapshotTextDelta(previous, textPart.text);
        const mappedSource = snapshotSourceForField(textPart.field, source);
        if (!delta) {
          return {
            event: null,
            debug: {
              partId,
              source: mappedSource,
              field: textPart.field,
              previousLen: previous.length,
              nextLen: textPart.text.length,
              emittedLen: 0,
              preview: textPart.text.slice(0, 80),
            },
          };
        }

        textSnapshots.set(key, source === 'updated-reset' ? textPart.text : previous + delta);
        return {
          event: {
            type: 'assistant.delta',
            payload: {
              text: delta,
              partId,
              field: textPart.field,
              // Non-prefix snapshot — client must replace, not concatenate
              ...(source === 'updated-reset' ? { replace: true } : {}),
            },
          },
          debug: {
            partId,
            source: mappedSource,
            field: textPart.field,
            previousLen: previous.length,
            nextLen: textPart.text.length,
            emittedLen: delta.length,
            deltaLen: delta.length,
            preview: delta.slice(0, 80),
          },
        };
      }
      case 'session.error': {
        const error = event.properties.error;
        return { event: { type: 'error', payload: { error }, status: 'failed' } };
      }
      case 'message.updated': {
        // OpenCode emits message.updated frequently; only finalize when the
        // assistant message has time.completed (see AssistantMessage.time).
        const info = event.properties.info as
          | { role?: string; time?: { completed?: number } }
          | undefined;
        if (info?.role !== 'assistant' || info.time?.completed == null) {
          return { event: null };
        }
        return { event: { type: 'assistant.message', payload: event.properties } };
      }
      case 'session.created':
      case 'session.updated':
        return { event: { type: 'session.status', payload: event.properties } };
      case 'permission.updated':
      case 'permission.replied':
      case 'permission.asked':
        return {
          event: {
            type: 'permission.requested',
            payload: event.properties,
          },
        };
      default: {
        const statusMapped = mapStatusEvent(event, mode);
        if (statusMapped) {
          return { event: statusMapped };
        }
        return { event: null };
      }
    }
  }

  return {
    map,
    reset: () => {
      textSnapshots.clear();
    },
    getTextSnapshot: (partId: string, field: TextStreamField = 'text') =>
      textSnapshots.get(snapshotKey(partId, field)),
  };
}

/** @deprecated Use createOpenCodeEventMapper() for streaming sessions. */
export function mapOpenCodeEvent(
  event: OpenCodeServerEvent,
  sessionId: string,
  mode: AgentRunMode,
): MappedOpenCodeEvent | null {
  return createOpenCodeEventMapper().map(event, sessionId, mode).event;
}
