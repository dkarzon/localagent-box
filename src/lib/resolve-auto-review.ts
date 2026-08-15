import type { AppConfig, Repo } from '../types';
/**
 * Resolve autoReviewPullRequests using tri-state precedence:
 * agent override → repo setting → global config default
 */
export function resolveAutoReviewPullRequests(
  agentOverride: boolean | null | undefined,
  repo: Repo | null | undefined,
  globalConfig: AppConfig | null | undefined,
): boolean {
  if (agentOverride !== null && agentOverride !== undefined) {
    return Boolean(agentOverride);
  }
  const repoSetting = repo?.autoReviewPullRequests;
  if (repoSetting !== null && repoSetting !== undefined) {
    return Boolean(repoSetting);
  }
  const globalSetting = globalConfig?.autoReviewPullRequests;
  if (globalSetting !== null && globalSetting !== undefined) {
    return Boolean(globalSetting);
  }
  return false;
}

/**
 * Check whether a review agent with the same PR data already exists to prevent spawning duplicates.
 */
export function isDuplicateReview(
  existingAgent: any,
  prNumber: number | string,
  headSha: string,
): boolean {
  if (!existingAgent?.review) return false;
  const r = existingAgent.review as Record<string, unknown>;
  return (
    typeof r.prNumber === 'number' &&
    Number(r.prNumber) === Number(prNumber) &&
    r.headSha === headSha
  );
}

const ACTIVE_REVIEW_STATUSES = new Set(['queued', 'running', 'processing', 'completing']);

/** Block duplicate review requests only while one is still in flight for the same parent and branch pair. */
export function isDuplicateBranchReview(
  existingAgent: {
    mode?: string;
    status?: string;
    parentAgentId?: string | null;
    review?: { baseBranch?: string | null; headBranch?: string | null } | null;
  },
  parentAgentId: string,
  baseBranch: string,
  headBranch: string,
): boolean {
  if (existingAgent.mode !== 'review' || existingAgent.parentAgentId !== parentAgentId) {
    return false;
  }
  if (!existingAgent.status || !ACTIVE_REVIEW_STATUSES.has(existingAgent.status)) {
    return false;
  }
  const review = existingAgent.review;
  if (!review) {
    return false;
  }
  return review.baseBranch === baseBranch && review.headBranch === headBranch;
}
