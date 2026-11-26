import fs from 'fs';
import path from 'path';
import type { Agent, AgentEvent, AgentEventType, AgentJob, AgentStatus } from '../../../types';
import type { JsonStore } from '../../../lib/json-store';

export function getAgentDir(job: AgentJob): string {
  return path.join(job.dataDir, 'agents', job.agentId);
}

/** Ensure the agent runtime directory exists (logs, transcripts, events). */
export function ensureAgentDir(job: AgentJob): string {
  const dir = getAgentDir(job);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
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

/**
 * Worker-side record update. Only the server cancels a run, so the worker never moves a
 * record out of `cancelled`: a status write that races a cancel (for example while host
 * checks run) keeps the cancel and applies the rest of the patch.
 */
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
  if (agents[index].status === 'cancelled') {
    merged.status = 'cancelled';
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

export function readAgentRecord(
  agentsStore: JsonStore<{ agents: Agent[] }>,
  agentId: string,
): Agent | null {
  const agent = (agentsStore.load().agents || []).find((entry) => entry.agentId === agentId);
  return agent ?? null;
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

