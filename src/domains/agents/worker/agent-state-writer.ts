import fs from 'fs';
import path from 'path';
import { buildInteractiveState } from '../../../lib/interactive-state';
import { buildLoopState } from '../../../lib/loop-state';
import type { Agent, AgentEvent, AgentEventType, AgentJob, AgentStatus, LoopVerb } from '../../../types';
import type { JsonStore } from '../../../lib/json-store';

export function getAgentDir(job: AgentJob): string {
  return path.join(job.dataDir, 'agents', job.agentId);
}

export function getInboxPath(job: AgentJob): string {
  return path.join(getAgentDir(job), 'inbox.jsonl');
}

export function getEventsPath(job: AgentJob): string {
  return path.join(getAgentDir(job), 'events.ndjson');
}

export function getConversationPath(job: AgentJob): string {
  return path.join(getAgentDir(job), 'conversation.jsonl');
}

export function appendLog(logPath: string, line: string): void {
  const timestamp = new Date().toISOString();
  fs.appendFileSync(logPath, `[${timestamp}] ${line}\n`, 'utf8');
}

export function appendLogBlock(logPath: string, header: string, body: string): void {
  appendLog(logPath, header);
  if (body && body.trim()) {
    for (const line of body.trimEnd().split('\n')) {
      fs.appendFileSync(logPath, `[${new Date().toISOString()}]   ${line}\n`, 'utf8');
    }
  }
}

export function updateAgentRecord(
  agentsStore: JsonStore<{ agents: Agent[] }>,
  agentId: string,
  patch: Partial<Agent>,
): void {
  const data = agentsStore.load();
  const agents = data.agents || [];
  const index = agents.findIndex((entry) => entry.agentId === agentId);
  if (index === -1) {
    return;
  }
  const merged = { ...agents[index], ...patch };
  if ((merged.mode || 'batch') === 'interactive') {
    merged.interactive = buildInteractiveState(merged.status);
  }
  if (merged.mode === 'loop') {
    merged.loop = buildLoopState(merged.status, merged.loop, merged);
  }
  agents[index] = merged;
  agentsStore.save({ agents });
}

export function readAgentStatus(
  agentsStore: JsonStore<{ agents: Agent[] }>,
  agentId: string,
): AgentStatus | null {
  const agent = (agentsStore.load().agents || []).find((entry) => entry.agentId === agentId);
  return agent?.status ?? null;
}

export function appendConversation(job: AgentJob, role: 'user' | 'assistant', text: string): void {
  const conversationPath = getConversationPath(job);
  fs.mkdirSync(path.dirname(conversationPath), { recursive: true });
  fs.appendFileSync(
    conversationPath,
    `${JSON.stringify({ ts: new Date().toISOString(), role, text })}\n`,
    'utf8',
  );
}

export class EventWriter {
  private seq = 0;

  constructor(private eventsPath: string) {
    fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
  }

  write(type: AgentEventType, payload: Record<string, unknown>, sessionId?: string): AgentEvent {
    this.seq += 1;
    const event: AgentEvent = {
      seq: this.seq,
      ts: new Date().toISOString(),
      type,
      sessionId,
      payload,
    };
    fs.appendFileSync(this.eventsPath, `${JSON.stringify(event)}\n`, 'utf8');
    return event;
  }
}

export type InboxCommand =
  | { type: 'message'; text: string; ts?: string }
  | { type: 'finish'; ts?: string };

export function readAgentLoopFinishRequested(
  agentsStore: JsonStore<{ agents: Agent[] }>,
  agentId: string,
): boolean {
  const agent = (agentsStore.load().agents || []).find((entry) => entry.agentId === agentId);
  return agent?.loop?.finishRequested === true;
}

export function emitLoopStepStart(
  eventWriter: EventWriter,
  payload: { iteration: number; stepIndex: number; verb: LoopVerb; model: string | null },
  sessionId?: string,
): AgentEvent {
  return eventWriter.write('loop.step.start', payload, sessionId);
}

export function emitLoopStepEnd(
  eventWriter: EventWriter,
  payload: {
    iteration: number;
    stepIndex: number;
    verb: LoopVerb;
    completionSignal?: boolean;
  },
  sessionId?: string,
): AgentEvent {
  return eventWriter.write('loop.step.end', payload, sessionId);
}

export function emitLoopIterationEnd(
  eventWriter: EventWriter,
  payload: { iteration: number; completed: boolean },
  sessionId?: string,
): AgentEvent {
  return eventWriter.write('loop.iteration.end', payload, sessionId);
}

export class InboxReader {
  private offset = 0;

  constructor(private inboxPath: string) {}

  poll(): InboxCommand[] {
    if (!fs.existsSync(this.inboxPath)) {
      return [];
    }
    const content = fs.readFileSync(this.inboxPath, 'utf8');
    const lines = content.split('\n').filter((line) => line.trim());
    const newLines = lines.slice(this.offset);
    this.offset = lines.length;
    return newLines.map((line) => JSON.parse(line) as InboxCommand);
  }

  pollFinishOnly(): boolean {
    if (!fs.existsSync(this.inboxPath)) {
      return false;
    }
    const content = fs.readFileSync(this.inboxPath, 'utf8');
    const lines = content.split('\n').filter((line) => line.trim());
    const newLines = lines.slice(this.offset);
    for (let i = 0; i < newLines.length; i++) {
      const command = JSON.parse(newLines[i]) as InboxCommand;
      if (command.type === 'finish') {
        for (let j = 0; j < i; j++) {
          const prior = JSON.parse(newLines[j]) as InboxCommand;
          if (prior.type === 'message') {
            return false;
          }
        }
        this.offset += i + 1;
        return true;
      }
    }
    return false;
  }
}
