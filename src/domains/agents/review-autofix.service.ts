import { CodedError } from '../../types';
import type { Agent, ReviewFindingRecord } from '../../types';
import type { AgentRepository } from './agent.repository';
import type { ConfigRepository } from '../config/config.repository';
import type { RepoService } from '../repos/repo.service';
import type { GithubAppService } from '../../services/github-app';
import { buildFixAgentPrompt } from '../../lib/review-autofix-prompt';
import { getAgentMode } from './agent.types';

/** Findings that can receive a new manual fix agent. */
const MANUALLY_ACTIONABLE_STATUSES = new Set<ReviewFindingRecord['fixStatus']>([
  'available',
  'failed',
]);

export interface ManualFixResult {
  agent: Agent;
  finding: ReviewFindingRecord;
  /** True when the reviewed SHA differs from the current head SHA (non-blocking warning). */
  staleReview: boolean;
}

export interface ReviewAutofixService {
  /**
   * Creates a one-finding batch agent that manually fixes a single review
   * finding. Never runs automatically; rejects while the finding is already
   * assigned to a queued or running fix agent.
   */
  createManualFix: (reviewAgentId: string, findingId: string) => Promise<ManualFixResult>;
  /**
   * Re-attempts host-side GitHub thread resolution for a fixed finding.
   * Never creates a coding agent; resolution failure keeps the fix agent
   * successful and leaves the finding retryable.
   */
  retryFindingResolution: (
    reviewAgentId: string,
    findingId: string,
  ) => Promise<ReviewFindingRecord>;
}

export function createReviewAutofixService({
  repository,
  repoManager,
  configRepository,
  githubApp,
  createBatchAgent,
}: {
  repository: AgentRepository;
  repoManager: RepoService;
  configRepository: ConfigRepository;
  githubApp: GithubAppService;
  /** Host-provided batch agent factory (agentService.createAgent). */
  createBatchAgent?: (body: Record<string, unknown>) => Agent;
}): ReviewAutofixService {
  /**
   * Manual Fix endpoint behavior per plan:
   *
   * Validation:
   * 1. Agent exists and is a review.
   * 2. Finding exists.
   * 3. No queued/running agent is already assigned to the finding (conflict).
   * 4. Reviewed head branch still exists on the remote.
   *
   * Behavior:
   * 1. Build a one-finding prompt.
   * 2. Create a normal batch agent on the review head branch with
   *    `useExistingBranch: true` and autofix metadata `kind: 'manual'`.
   * 3. Mark the finding assigned only after agent creation succeeds.
   * 4. Do not reject stale SHA findings; return staleness metadata instead.
   */
  async function createManualFix(
    reviewAgentId: string,
    findingId: string,
  ): Promise<ManualFixResult> {
    if (typeof createBatchAgent !== 'function') {
      throw new CodedError('Manual fix is not available', 'VALIDATION_ERROR');
    }

    const agent = repository.getAgent(reviewAgentId);
    if (getAgentMode(agent) !== 'review') {
      throw new CodedError('Agent is not a review session', 'INVALID_MODE');
    }

    const headBranch = agent.review?.headBranch || agent.agentBranch;
    if (!headBranch) {
      throw new CodedError('Review has no head branch to fix against', 'VALIDATION_ERROR');
    }

    const findings = repository.readReviewFindings(reviewAgentId);
    if (!findings) {
      throw new CodedError('Structured findings are not available for this review', 'NOT_FOUND');
    }
    const finding = findings.find((entry) => entry.id === findingId);
    if (!finding) {
      throw new CodedError(`Finding not found: ${findingId}`, 'NOT_FOUND');
    }
    if (!MANUALLY_ACTIONABLE_STATUSES.has(finding.fixStatus)) {
      throw new CodedError(
        `Finding is ${finding.fixStatus}; manual fix is not available while a fix agent is assigned`,
        'DUPLICATE',
      );
    }

    const repo = repoManager.getRepo(agent.repoId);
    const config = configRepository.load();
    let branches: string[];
    try {
      branches = await githubApp.fetchRepositoryBranches(config, repo.owner, repo.name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new CodedError(`Could not verify the head branch: ${message}`, 'VALIDATION_ERROR');
    }
    if (!branches.includes(headBranch)) {
      throw new CodedError(
        `Head branch ${headBranch} no longer exists on the remote`,
        'VALIDATION_ERROR',
      );
    }

    const reviewedSha = finding.reviewedSha;
    const staleReview =
      Boolean(reviewedSha) && typeof agent.review?.headSha === 'string' && agent.review.headSha !== reviewedSha;

    const prompt = buildFixAgentPrompt([finding], { headBranch, reviewedSha });

    let fixAgent: Agent;
    try {
      fixAgent = createBatchAgent({
        repoId: agent.repoId,
        mode: 'batch',
        prompt,
        baseBranch: agent.baseBranch || headBranch,
        agentBranch: headBranch,
        useExistingBranch: true,
        push: true,
        autofix: {
          kind: 'manual',
          sourceReviewAgentId: reviewAgentId,
          findingIds: [finding.id],
        },
      } as Record<string, unknown>);
    } catch (err) {
      // Agent creation failed — the finding stays actionable; nothing was assigned.
      if (err instanceof CodedError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new CodedError(`Could not create the fix agent: ${message}`, 'VALIDATION_ERROR');
    }

    finding.fixStatus = 'assigned';
    finding.assignedAgentId = fixAgent.agentId;
    repository.writeReviewFindings(reviewAgentId, findings);

    return { agent: fixAgent, finding, staleReview };
  }
  /**
   * Resolves the GitHub review thread linked to a fixed finding.
   *
   * Validation per plan:
   * 1. Finding is marked fixed.
   * 2. It has a GitHub comment ID or cached thread ID.
   * 3. Resolution is pending or failed.
   *
   * API/mapping failures persist `resolutionStatus: 'failed'` with a
   * user-readable error and are returned as a normal (non-throwing) response so
   * coding-agent success is never affected by resolution problems.
   */
  async function retryFindingResolution(
    reviewAgentId: string,
    findingId: string,
  ): Promise<ReviewFindingRecord> {
    const agent = repository.getAgent(reviewAgentId);
    if (getAgentMode(agent) !== 'review') {
      throw new CodedError('Agent is not a review session', 'INVALID_MODE');
    }

    const findings = repository.readReviewFindings(reviewAgentId);
    if (!findings) {
      throw new CodedError('Structured findings are not available for this review', 'NOT_FOUND');
    }
    const finding = findings.find((entry) => entry.id === findingId);
    if (!finding) {
      throw new CodedError(`Finding not found: ${findingId}`, 'NOT_FOUND');
    }
    if (finding.fixStatus !== 'fixed') {
      throw new CodedError('Finding is not marked fixed', 'VALIDATION_ERROR');
    }
    if (finding.github.commentId === null && finding.github.threadId === null) {
      throw new CodedError('Finding has no linked GitHub comment or thread', 'VALIDATION_ERROR');
    }
    if (
      finding.github.resolutionStatus !== 'pending' &&
      finding.github.resolutionStatus !== 'failed'
    ) {
      throw new CodedError(
        `Resolution is ${finding.github.resolutionStatus}; retry is not applicable`,
        'VALIDATION_ERROR',
      );
    }

    const config = configRepository.load();

    const failResolution = (message: string): ReviewFindingRecord => {
      finding.github.resolutionStatus = 'failed';
      finding.github.resolutionError = message;
      repository.writeReviewFindings(reviewAgentId, findings);
      return finding;
    };

    try {
      let threadId = finding.github.threadId;

      // Thread lookup needs the PR; resolution with a cached thread ID does not.
      if (!threadId) {
        if (typeof finding.github.commentId !== 'number') {
          throw new Error('Finding has no resolvable GitHub thread');
        }
        const prNumber = agent.review?.prNumber ?? null;
        if (typeof prNumber !== 'number') {
          throw new Error('Review is not linked to a pull request; thread lookup is unavailable');
        }
        const repo = repoManager.getRepo(agent.repoId);
        const lookup = await githubApp.findReviewThreadIdForComment(
          config,
          repo.owner,
          repo.name,
          prNumber,
          finding.github.commentId,
        );
        if (!lookup) {
          throw new Error('Could not find the GitHub review thread for this comment');
        }
        threadId = lookup.threadId;
        finding.github.threadId = threadId;
      }

      await githubApp.resolvePullRequestReviewThread(config, threadId);

      // An already-resolved thread is treated as success by the GitHub service.
      finding.github.resolutionStatus = 'resolved';
      finding.github.resolutionError = null;
      finding.github.resolvedAt = new Date().toISOString();
      repository.writeReviewFindings(reviewAgentId, findings);
      return finding;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return failResolution(message);
    }
  }

  return {
    createManualFix,
    retryFindingResolution,
  };
}