import type { Agent, AgentStatus } from '../../types';
import { getAgentMode, TERMINAL_STATUSES } from './agent.types';

/** Statuses that mean a worker is (or should be) occupying the branch. */
const BRANCH_WORKER_STATUSES = new Set<AgentStatus>([
  'running',
  'awaiting_input',
  'processing',
  'completing',
]);

export type QueueDecision = 'start' | 'defer' | 'drop';

export function findCodingPredecessor(agents: readonly Agent[], agent: Agent): Agent | undefined {
  let predecessor: Agent | undefined;
  for (const candidate of agents) {
    if (candidate.agentId === agent.agentId) {
      continue;
    }
    if (candidate.repoId !== agent.repoId || candidate.agentBranch !== agent.agentBranch) {
      continue;
    }
    if (getAgentMode(candidate) === 'review') {
      continue;
    }
    if (candidate.createdAt >= agent.createdAt) {
      continue;
    }
    if (!predecessor || candidate.createdAt > predecessor.createdAt) {
      predecessor = candidate;
    }
  }
  return predecessor;
}

export function predecessorAllowsStart(predecessor: Agent | undefined): boolean {
  if (!predecessor) {
    return true;
  }
  if (predecessor.status === 'completed' && predecessor.pushed) {
    return true;
  }
  if (
    (predecessor.status === 'failed' || predecessor.status === 'cancelled') &&
    predecessor.allowSuccessors
  ) {
    return true;
  }
  return false;
}

export function hasLiveWorkerOnBranch(
  agents: readonly Agent[],
  agent: Agent,
  hasWorker: (agentId: string) => boolean,
): boolean {
  return agents.some(
    (other) =>
      other.agentId !== agent.agentId &&
      other.repoId === agent.repoId &&
      other.agentBranch === agent.agentBranch &&
      (hasWorker(other.agentId) || BRANCH_WORKER_STATUSES.has(other.status)),
  );
}

function isAwaitingWorker(agent: Agent, hasWorker: (agentId: string) => boolean): boolean {
  return agent.status === 'queued' || (agent.status === 'completing' && !hasWorker(agent.agentId));
}

export function decideQueueAction(
  agent: Agent | undefined,
  allAgents: readonly Agent[],
  hasWorker: (agentId: string) => boolean,
): QueueDecision {
  if (!agent || TERMINAL_STATUSES.has(agent.status) || !isAwaitingWorker(agent, hasWorker)) {
    return 'drop';
  }
  if (hasLiveWorkerOnBranch(allAgents, agent, hasWorker)) {
    return 'defer';
  }
  if (getAgentMode(agent) !== 'review' && !predecessorAllowsStart(findCodingPredecessor(allAgents, agent))) {
    return 'defer';
  }
  return 'start';
}
