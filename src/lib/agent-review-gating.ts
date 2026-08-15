import type { Agent, AgentStatus } from '../types';

const ACTIVE_AGENT_STATUSES = new Set<AgentStatus>([
  'queued',
  'running',
  'awaiting_input',
  'processing',
  'completing',
]);

function isDuplicateBranchReview(
  existing: Agent,
  parentAgentId: string,
  baseBranch: string,
  headBranch: string,
): boolean {
  if (existing.mode !== 'review' || existing.parentAgentId !== parentAgentId) {
    return false;
  }
  if (!ACTIVE_AGENT_STATUSES.has(existing.status)) {
    return false;
  }
  const review = existing.review;
  if (!review) {
    return false;
  }
  return review.baseBranch === baseBranch && review.headBranch === headBranch;
}

function isBranchInUse(agents: Agent[], repoId: string, branch: string, excludeAgentId?: string): boolean {
  return agents.some(
    (a) =>
      a.agentId !== excludeAgentId &&
      a.repoId === repoId &&
      ACTIVE_AGENT_STATUSES.has(a.status) &&
      a.agentBranch === branch,
  );
}

export function canReviewBranches(
  agent: Agent,
  options: { relatedAgents?: Agent[]; baseBranch?: string; agentsLoaded?: boolean },
): boolean {
  if (agent.mode === 'review' || agent.status !== 'completed' || !agent.pushed) {
    return false;
  }

  const headBranch = agent.agentBranch || agent.branch!;
  if (!headBranch) {
    return false;
  }

  if (!options.agentsLoaded) {
    return false;
  }

  const relatedAgents = options.relatedAgents ?? [];

  if (
    options.baseBranch &&
    relatedAgents.some((a) => isDuplicateBranchReview(a, agent.agentId, options.baseBranch!, headBranch))
  ) {
    return false;
  }

  if (isBranchInUse(relatedAgents, agent.repoId, headBranch, agent.agentId)) {
    return false;
  }

  return true;
}
