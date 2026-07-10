import { formatToolValue } from '../lib/format-tool';
import { resolveToolCallId } from '../lib/resolve-tool-call-id';

export type AgentEventType =
  | 'session.status'
  | 'assistant.delta'
  | 'assistant.message'
  | 'tool.start'
  | 'tool.end'
  | 'permission.requested'
  | 'error'
  | 'log.line'
  | 'loop.step.start'
  | 'loop.step.end'
  | 'loop.iteration.end';

export interface LoopStepEventPayload {
  iteration: number;
  stepIndex: number;
  verb: string;
  model?: string | null;
  completionSignal?: boolean;
}

export interface LoopIterationEndPayload {
  iteration: number;
  completed: boolean;
}

export interface AgentEvent {
  seq: number;
  ts: string;
  type: AgentEventType;
  sessionId?: string;
  payload: Record<string, unknown>;
}

export interface AgentMessage {
  ts: string;
  role: 'user' | 'assistant';
  text: string;
}

export interface TranscriptToolCall {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'error';
  startedAt: string;
  endedAt?: string;
  title?: string;
  input?: string;
  output?: string;
  error?: string;
}

export interface TranscriptEntry {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  ts: string;
  streaming?: boolean;
  toolCall?: TranscriptToolCall;
}

export interface ParsedToolPayload {
  callId: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  input?: unknown;
  output?: string;
  error?: string;
  title?: string;
}

export function extractAssistantText(payload: Record<string, unknown>): string {
  const info = payload.info as { content?: string; text?: string } | undefined;
  if (typeof info?.content === 'string') return info.content;
  if (typeof info?.text === 'string') return info.text;

  const parts = payload.parts as Array<{ type?: string; text?: string }> | undefined;
  if (Array.isArray(parts)) {
    return parts
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
  }

  if (typeof payload.text === 'string') return payload.text;
  return '';
}

function readLegacyToolState(part: Record<string, unknown>): ParsedToolPayload['status'] {
  const state = part.state;
  if (state && typeof state === 'object' && !Array.isArray(state)) {
    const status = String((state as Record<string, unknown>).status || 'running');
    if (status === 'pending') return 'pending';
    if (status === 'completed') return 'completed';
    if (status === 'error') return 'error';
    return 'running';
  }
  if (state === 'completed') return 'completed';
  if (state === 'error') return 'error';
  if (state === 'pending') return 'pending';
  return 'running';
}

function readLegacyToolFields(part: Record<string, unknown>): ParsedToolPayload {
  const state = part.state;
  const fields: ParsedToolPayload = {
    callId: resolveToolCallId(part),
    name: String(part.tool || part.name || 'tool'),
    status: readLegacyToolState(part),
  };

  if (state && typeof state === 'object' && !Array.isArray(state)) {
    const record = state as Record<string, unknown>;
    fields.input = record.input;
    fields.output = formatToolValue(record.output);
    fields.error = formatToolValue(record.error);
    fields.title = typeof record.title === 'string' ? record.title : undefined;
  }

  return fields;
}

/** Read normalized or legacy tool payload from an agent event. */
export function extractToolFromPayload(payload: Record<string, unknown>): ParsedToolPayload {
  const normalized = payload.tool as ParsedToolPayload | undefined;
  if (normalized && typeof normalized === 'object') {
    return {
      callId: String(normalized.callId || normalized.name || 'tool'),
      name: String(normalized.name || 'tool'),
      status: normalized.status || 'running',
      input: normalized.input,
      output: normalized.output,
      error: normalized.error,
      title: normalized.title,
    };
  }

  const part = payload.part as Record<string, unknown> | undefined;
  if (part && part.type === 'tool') {
    return readLegacyToolFields(part);
  }

  return {
    callId: 'tool',
    name: 'tool',
    status: 'running',
  };
}

export function extractToolName(payload: Record<string, unknown>): string {
  const tool = extractToolFromPayload(payload);
  return tool.name;
}
