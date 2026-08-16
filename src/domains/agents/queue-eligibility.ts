import type { Agent, AgentQueueState, AgentQueueWaitingOn, AgentStatus } from '../../types';
import { ACTIVE_STATUSES, getAgentMode, TERMINAL_STATUSES } from './agent.types';

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
  if (hasWorker(agent.agentId)) {
    return false;
  }
  return agent.status === 'queued' || agent.status === 'completing';
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

export function hasQueuedCodingSuccessor(agents: readonly Agent[], agent: Agent): boolean {
  return agents.some(
    (other) =>
      other.agentId !== agent.agentId &&
      other.repoId === agent.repoId &&
      other.agentBranch === agent.agentBranch &&
      getAgentMode(other) !== 'review' &&
      other.status === 'queued' &&
      other.createdAt > agent.createdAt,
  );
}

export function hasActiveCodingOnBranch(
  agents: readonly Agent[],
  repoId: string,
  branch: string,
  excludeAgentId?: string,
): boolean {
  return agents.some(
    (other) =>
      other.agentId !== excludeAgentId &&
      other.repoId === repoId &&
      other.agentBranch === branch &&
      getAgentMode(other) !== 'review' &&
      ACTIVE_STATUSES.has(other.status),
  );
}

function predecessorWaitReason(predecessor: Agent): string {
  if (predecessor.status === 'failed' || predecessor.status === 'cancelled') {
    return `Waiting for ${predecessor.agentId} (${predecessor.status}) — retry that session or start next`;
  }
  return `Waiting for ${predecessor.agentId} to finish and push`;
}

export function buildAgentQueueState(
  agent: Agent,
  allAgents: readonly Agent[],
  hasWorker: (agentId: string) => boolean,
): AgentQueueState {
  const predecessor = findCodingPredecessor(allAgents, agent);
  const canRetry = agent.status === 'failed' || agent.status === 'cancelled';
  const canAllowSuccessors =
    canRetry && !agent.allowSuccessors && hasQueuedCodingSuccessor(allAgents, agent);

  if (!isAwaitingWorker(agent, hasWorker)) {
    return {
      position: null,
      waitingOn: null,
      predecessorId: predecessor?.agentId ?? null,
      predecessorStatus: predecessor?.status ?? null,
      reason: null,
      canRetry,
      canAllowSuccessors,
    };
  }

  const queuedOnBranch = allAgents
    .filter(
      (other) =>
        other.repoId === agent.repoId &&
        other.agentBranch === agent.agentBranch &&
        other.status === 'queued',
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.agentId.localeCompare(b.agentId));
  const index = queuedOnBranch.findIndex((other) => other.agentId === agent.agentId);
  const position = index === -1 ? null : index + 1;

  const branchBusy = hasLiveWorkerOnBranch(allAgents, agent, hasWorker);
  const predecessorBlocks =
    getAgentMode(agent) !== 'review' && !predecessorAllowsStart(predecessor);

  let waitingOn: AgentQueueWaitingOn | null = null;
  let reason: string | null = null;
  if (predecessorBlocks && predecessor) {
    waitingOn = 'predecessor';
    reason = predecessorWaitReason(predecessor);
  } else if (branchBusy) {
    waitingOn = 'branch_worker';
    reason = 'Waiting for another session on this branch to finish';
  } else {
    waitingOn = 'slot';
    reason = 'Waiting for a worker slot';
  }

  return {
    position,
    waitingOn,
    predecessorId: predecessor?.agentId ?? null,
    predecessorStatus: predecessor?.status ?? null,
    reason,
    canRetry,
    canAllowSuccessors,
  };
}
