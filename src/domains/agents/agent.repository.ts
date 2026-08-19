import fs from 'fs';
import path from 'path';
import type { Agent, AgentEvent, AgentMessage } from '../../types';
import type { JsonStore } from '../../lib/json-store';
import { CodedError } from '../../types';
import { getAgentMode, withDerivedAgentFields } from './agent.types';

type FsLike = Pick<
  typeof import('fs'),
  'mkdirSync' | 'existsSync' | 'writeFileSync' | 'readFileSync' | 'appendFileSync' | 'rmSync'
>;

export interface AgentRepository {
  findAll: () => Agent[];
  findById: (agentId: string) => Agent | undefined;
  saveAll: (agents: Agent[]) => void;
  save: (agent: Agent) => void;
  update: (agentId: string, patch: Partial<Agent>) => Agent | null;
  remove: (agentId: string) => Agent | undefined;
  getAgent: (agentId: string) => Agent;
  list: (filters?: { repoId?: string; status?: string }) => Agent[];
  getAgentDir: (agentId: string) => string;
  getLogPath: (agentId: string) => string;
  getInboxPath: (agentId: string) => string;
  getEventsPath: (agentId: string) => string;
  getConversationPath: (agentId: string) => string;
  getReviewResultPath: (agentId: string) => string;
  readReviewResult: (agentId: string) => Record<string, unknown> | null;
  getReviewSessionPath: (agentId: string) => string;
  readReviewSession: (agentId: string) => Record<string, unknown> | null;
  getWorkspaceDir: (workspaceId: string) => string;
  appendInbox: (agentId: string, entry: Record<string, unknown>) => void;
  readLogs: (agentId: string, tailLines?: number) => { logs: string; tail: number };
  readEvents: (agentId: string, sinceSeq?: number) => AgentEvent[];
  getLastEventSeq: (agentId: string) => number;
  readMessages: (agentId: string) => AgentMessage[];
  removeArtifacts: (agent: Agent) => void;
  assertInteractive: (agent: Agent) => void;
  assertFinishable: (agent: Agent) => void;
}

export function createAgentRepository(options: {
  dataDir: string;
  workspaceRoot: string;
  agentsStore: JsonStore<{ agents: Agent[] }>;
  fs?: FsLike;
  path?: typeof path;
}): AgentRepository {
  const fsImpl = options.fs || fs;
  const pathImpl = options.path || path;
  const { dataDir, workspaceRoot, agentsStore } = options;

  function loadAgents(): Agent[] {
    return agentsStore.load().agents || [];
  }

  function saveAll(agents: Agent[]): void {
    agentsStore.save({ agents });
  }

  function getAgentDir(agentId: string): string {
    return pathImpl.join(dataDir, 'agents', agentId);
  }

  function getLogPath(agentId: string): string {
    return pathImpl.join(getAgentDir(agentId), 'worker.log');
  }

  function getInboxPath(agentId: string): string {
    return pathImpl.join(getAgentDir(agentId), 'inbox.jsonl');
  }

  function getEventsPath(agentId: string): string {
    return pathImpl.join(getAgentDir(agentId), 'events.ndjson');
  }

  function getConversationPath(agentId: string): string {
    return pathImpl.join(getAgentDir(agentId), 'conversation.jsonl');
  }

  function getReviewResultPath(agentId: string): string {
    return pathImpl.join(getAgentDir(agentId), 'review-result.json');
  }

  function readReviewResult(agentId: string): Record<string, unknown> | null {
    getAgent(agentId);
    const resultPath = getReviewResultPath(agentId);
    if (!fsImpl.existsSync(resultPath)) {
      return null;
    }
    return JSON.parse(fsImpl.readFileSync(resultPath, 'utf8')) as Record<string, unknown>;
  }

  function getReviewSessionPath(agentId: string): string {
    return pathImpl.join(getAgentDir(agentId), 'review-session.json');
  }

  function readReviewSession(agentId: string): Record<string, unknown> | null {
    getAgent(agentId);
    const sessionPath = getReviewSessionPath(agentId);
    if (!fsImpl.existsSync(sessionPath)) {
      return null;
    }
    return JSON.parse(fsImpl.readFileSync(sessionPath, 'utf8')) as Record<string, unknown>;
  }

  function getWorkspaceDir(workspaceId: string): string {
    return pathImpl.join(workspaceRoot, workspaceId);
  }

  function findById(agentId: string): Agent | undefined {
    return loadAgents().find((entry) => entry.agentId === agentId);
  }

  function update(agentId: string, patch: Partial<Agent>): Agent | null {
    const agents = loadAgents();
    const index = agents.findIndex((entry) => entry.agentId === agentId);
    if (index === -1) {
      return null;
    }
    agents[index] = { ...agents[index], ...patch };
    saveAll(agents);
    return agents[index];
  }

  function getAgent(agentId: string): Agent {
    const agent = findById(agentId);
    if (!agent) {
      throw new CodedError('Agent not found', 'NOT_FOUND');
    }
    return withDerivedAgentFields(agent);
  }

  function assertInteractive(agent: Agent): void {
    if (getAgentMode(agent) !== 'interactive') {
      throw new CodedError('Agent is not in interactive mode', 'NOT_INTERACTIVE');
    }
  }

  function assertFinishable(agent: Agent): void {
    const mode = getAgentMode(agent);
    if (mode !== 'interactive' && mode !== 'loop') {
      throw new CodedError('Agent is not in interactive or loop mode', 'NOT_INTERACTIVE');
    }
  }

  return {
    findAll: loadAgents,
    findById,
    saveAll,
    save: (agent) => {
      const agents = loadAgents();
      agents.push(agent);
      saveAll(agents);
    },
    update,
    remove: (agentId) => {
      const agents = loadAgents();
      const index = agents.findIndex((entry) => entry.agentId === agentId);
      if (index === -1) {
        return undefined;
      }
      const [removed] = agents.splice(index, 1);
      saveAll(agents);
      return removed;
    },
    getAgent,
    list: (filters = {}) => {
      let agents = loadAgents().map(withDerivedAgentFields);
      if (filters.repoId) {
        agents = agents.filter((agent) => agent.repoId === filters.repoId);
      }
      if (filters.status) {
        agents = agents.filter((agent) => agent.status === filters.status);
      }
      return agents;
    },
    getAgentDir,
    getLogPath,
    getInboxPath,
    getEventsPath,
    getConversationPath,
    getReviewResultPath,
    readReviewResult,
    getReviewSessionPath,
    readReviewSession,
    getWorkspaceDir,
    appendInbox: (agentId, entry) => {
      fsImpl.appendFileSync(getInboxPath(agentId), `${JSON.stringify(entry)}\n`, 'utf8');
    },
    readLogs: (agentId, tailLines) => {
      getAgent(agentId);
      const logPath = getLogPath(agentId);
      if (!fsImpl.existsSync(logPath)) {
        return { logs: '', tail: 0 };
      }
      const content = fsImpl.readFileSync(logPath, 'utf8');
      if (!tailLines || tailLines <= 0) {
        return { logs: content, tail: content.split('\n').length };
      }
      const lines = content.split('\n');
      const tail = lines.slice(-tailLines).join('\n');
      return { logs: tail, tail: Math.min(tailLines, lines.length) };
    },
    readEvents: (agentId, sinceSeq = 0) => {
      getAgent(agentId);
      const eventsPath = getEventsPath(agentId);
      if (!fsImpl.existsSync(eventsPath)) {
        return [];
      }
      return fsImpl
        .readFileSync(eventsPath, 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as AgentEvent)
        .filter((event) => event.seq > sinceSeq);
    },
    getLastEventSeq: (agentId) => {
      getAgent(agentId);
      const eventsPath = getEventsPath(agentId);
      if (!fsImpl.existsSync(eventsPath)) {
        return 0;
      }
      const lines = fsImpl
        .readFileSync(eventsPath, 'utf8')
        .split('\n')
        .filter((line) => line.trim());
      if (lines.length === 0) {
        return 0;
      }
      const last = JSON.parse(lines[lines.length - 1]!) as AgentEvent;
      return last.seq;
    },
    readMessages: (agentId) => {
      const agent = getAgent(agentId);
      const conversationPath = getConversationPath(agentId);
      if (!fsImpl.existsSync(conversationPath)) {
        if (agent.prompt) {
          return [{ ts: agent.createdAt, role: 'user', text: agent.prompt }];
        }
        return [];
      }
      return fsImpl
        .readFileSync(conversationPath, 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as AgentMessage);
    },
    removeArtifacts: (agent) => {
      const workspaceDir = getWorkspaceDir(agent.workspaceId);
      if (fsImpl.existsSync(workspaceDir)) {
        fsImpl.rmSync(workspaceDir, { recursive: true, force: true });
      }
      const agentDir = getAgentDir(agent.agentId);
      if (fsImpl.existsSync(agentDir)) {
        fsImpl.rmSync(agentDir, { recursive: true, force: true });
      }
    },
    assertInteractive,
    assertFinishable,
  };
}
