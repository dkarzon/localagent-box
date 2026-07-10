import { formatToolValue } from './format-tool-value';
import { resolveToolCallId } from './resolve-tool-call-id';

/** Normalized tool payload stored in agent events.ndjson */
export interface NormalizedTool {
  callId: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  input?: unknown;
  output?: string;
  error?: string;
  title?: string;
}

function readToolState(part: Record<string, unknown>): {
  status: NormalizedTool['status'];
  input?: unknown;
  output?: string;
  error?: string;
  title?: string;
} {
  const state = part.state;
  if (state && typeof state === 'object' && !Array.isArray(state)) {
    const record = state as Record<string, unknown>;
    const rawStatus = String(record.status || 'running');
    let status: NormalizedTool['status'] = 'running';
    if (rawStatus === 'pending') {
      status = 'pending';
    } else if (rawStatus === 'completed') {
      status = 'completed';
    } else if (rawStatus === 'error') {
      status = 'error';
    }
    return {
      status,
      input: record.input,
      output: formatToolValue(record.output),
      error: formatToolValue(record.error),
      title: typeof record.title === 'string' ? record.title : undefined,
    };
  }

  if (typeof state === 'string') {
    if (state === 'completed') {
      return { status: 'completed' };
    }
    if (state === 'error') {
      return { status: 'error' };
    }
    if (state === 'pending') {
      return { status: 'pending' };
    }
    return { status: 'running' };
  }

  return { status: 'running' };
}

/** Map an OpenCode tool message part to a stable persisted shape. */
export function normalizeToolPart(part: Record<string, unknown>): NormalizedTool | null {
  if (part.type !== 'tool') {
    return null;
  }

  const name = String(part.tool || part.name || 'tool');
  const callId = resolveToolCallId(part);
  const stateFields = readToolState(part);

  return {
    callId,
    name,
    status: stateFields.status,
    input: stateFields.input,
    output: stateFields.output,
    error: stateFields.error,
    title: stateFields.title,
  };
}

export function isTerminalToolStatus(status: NormalizedTool['status']): boolean {
  return status === 'completed' || status === 'error';
}
