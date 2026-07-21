import type { Repo } from '../../../types';
import type { AppConfig } from '../../../services/config-store';

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
  if (repo?.autoReviewPullRequests !== null && repo.autoReviewPullRequests !== undefined) {
    return Boolean(repo.autoReviewPullRequests);
  }
  if (globalConfig?.autoReviewPullRequests !== null && globalConfig.autoReviewPullRequests !== undefined) {
    return Boolean(globalConfig.autoReviewPullRequests);
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
    r.headShaString === headSha
  );
}
