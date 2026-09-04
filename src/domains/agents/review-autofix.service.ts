import { CodedError } from '../../types';
import type {
  Agent,
  AutofixBatchPlan,
  ReviewAutofixPlan,
  ReviewFindingRecord,
} from '../../types';
import type { AgentRepository } from './agent.repository';
import type { ConfigRepository } from '../config/config.repository';
import type { RepoService } from '../repos/repo.service';
import type { GithubAppService } from '../../services/github-app';
import { getLogger } from '../../lib/logger';
import { buildFixAgentPrompt } from '../../lib/review-autofix-prompt';
import { getAgentMode } from './agent.types';
import { appendLog } from './worker/agent-state-writer';

/** Findings that can receive a new manual fix agent. */
const MANUALLY_ACTIONABLE_STATUSES = new Set<ReviewFindingRecord['fixStatus']>([
  'available',
  'failed',
]);

/** Agent statuses that count as queued/running fix work for drain checks. */
const ACTIVE_FIX_STATUSES = new Set<Agent['status']>([
  'queued',
  'running',
  'processing',
  'completing',
]);

/** Agent statuses a fix agent can have after an interrupted run (non-live). */
const ACTIVE_FIX_TERMINAL_OR_STOPPED = new Set<Agent['status']>([
  'running',
  'processing',
  'completing',
  'completed',
  'failed',
  'cancelled',
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
   * Creates the first automatic batch agent for a review whose completed run
   * materialized a running autofix plan. Idempotent: a no-op unless the plan
   * exists, the chain is running, and no batch has been created yet. Batch
   * creation failure marks the first batch failed and pauses the chain.
   */
  startAutomaticChain: (reviewAgentId: string) => Promise<void>;
  /**
   * Resumes a paused automatic chain (plan: `POST .../autofix/resume`).
   * Validation: the plan exists, the chain is `paused`, no automatic fix agent
   * for this plan is still active, and a later pending batch exists. The
   * failed batch is marked skipped (its findings stay manually fixable), the
   * chain returns to `running`, and the next pending batch is created.
   * Duplicate invocations reject with `DUPLICATE` instead of creating
   * duplicate agents.
   */
  resumeAutomaticChain: (reviewAgentId: string) => Promise<{ batchIndex: number }>;
  /**
   * Re-attempts host-side GitHub thread resolution for a fixed finding.
   * Never creates a coding agent; resolution failure keeps the fix agent
   * successful and leaves the finding retryable.
   */
  retryFindingResolution: (
    reviewAgentId: string,
    findingId: string,
  ) => Promise<ReviewFindingRecord>;
  /**
   * Lifecycle hook for the central worker start path. When the starting agent
   * carries autofix metadata, its assigned findings move from `assigned` to
   * `fixing` and its automatic batch (if any) moves from `queued` to `running`.
   */
  handleFixAgentStarted: (fixAgentId: string) => void;
  /**
   * Lifecycle hook for the central worker exit path. Reads the terminal agent
   * record and advances finding/batch/chain state:
   * - completed + pushed: findings fixed, host resolves linked threads, batch
   *   completed, then the next pending batch is created (or the chain is
   *   completed when none remain).
   * - failed/cancelled/completed without push: findings failed (manually
   *   actionable again), batch failed, chain paused, no further batches.
   */
  handleFixAgentFinished: (fixAgentId: string) => Promise<void>;
  /**
   * Creates the single autofix-ineligible verification review for a source
   * review once related fix work has drained. Guards: no related fix agent
   * queued/running on the branch, no existing verification for the source
   * review (plan dedup + agent dedup), and the created review is marked
   * `autofixIneligible` so it can never start another chain. Returns the
   * created review agent ID, or null when a guard held.
   */
  scheduleVerificationReview: (
    reviewAgentId: string,
    trigger: 'automatic' | 'manual',
  ) => Promise<string | null>;
  /**
   * Reconciles every persisted autofix plan after a server restart (plan:
   * Phase 7 "Reconcile plans during server startup"). Never creates agents —
   * it only derives safe outcomes from existing agent records so an
   * interruption cannot duplicate fix agents:
   * - queued agent record exists: assignment retained.
   * - running status with no live worker: outcome derived from the agent record
   *   (completed+pushed → completed; otherwise failed) and the chain is paused.
   * - missing agent record: batch failed, chain paused, findings actionable.
   * - a running chain whose queued agent still exists is enqueued for the
   *   normal worker pipeline by the caller (restoreOnStartup re-enqueue).
   */
  reconcileAutofixPlansOnStartup: () => void;
}

export function createReviewAutofixService({
  repository,
  repoManager,
  configRepository,
  githubApp,
  createBatchAgent,
  createReviewAgent,
}: {
  repository: AgentRepository;
  repoManager: RepoService;
  configRepository: ConfigRepository;
  githubApp: GithubAppService;
  /** Host-provided batch agent factory (agentService.createAgent). */
  createBatchAgent?: (body: Record<string, unknown>) => Agent;
  /** Host-provided review agent factory (agentService.createAgent). */
  createReviewAgent?: (body: Record<string, unknown>) => Agent;
}): ReviewAutofixService {
  /**
   * Structured log for autofix orchestration events (plan: Phase 7 task 6).
   * Carries the review ID, batch index, finding IDs, and fix agent ID so each
   * lifecycle event is traceable without parsing free-text logs.
   */
  function logAutofixEvent(
    event: string,
    data: {
      reviewAgentId: string;
      batchIndex?: number | null;
      findingIds?: string[];
      fixAgentId?: string | null;
      detail?: string;
    },
  ): void {
    getLogger().info(
      {
        event,
        reviewAgentId: data.reviewAgentId,
        batchIndex: data.batchIndex ?? undefined,
        findingIds: data.findingIds,
        fixAgentId: data.fixAgentId ?? undefined,
        detail: data.detail,
      },
      `autofix.${event}`,
    );
  }
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
   * Creates the first automatic batch agent for a completed review.
   *
   * Per plan (Phase 5 tasks 3–4 and "Creating automatic batches"):
   * - Reloads the latest plan from disk; a missing plan or a chain that is not
   *   `running` is a no-op (autofix disabled or verification review).
   * - Idempotence guard: only the first pending batch without an agent ID is
   *   eligible, so a completed/failed chain or a retry never duplicates agents.
   * - Builds the batch prompt from the assigned findings and creates exactly
   *   one batch agent (`useExistingBranch: true`, autofix metadata
   *   `kind: 'automatic'`, `batchIndex: 0`).
   * - Persists the agent ID and queued status, then marks its findings
   *   assigned only after agent creation succeeds.
   * - On creation failure: mark the batch failed and pause the chain so later
   *   batches are never created automatically.
   */
  async function startAutomaticChain(reviewAgentId: string): Promise<void> {
    if (typeof createBatchAgent !== 'function') {
      return;
    }

    const agent = repository.getAgent(reviewAgentId);
    if (getAgentMode(agent) !== 'review') {
      return;
    }

    // Loop-prevention invariant 8: verification reviews never start an
    // automatic fix chain.
    if (agent.review?.autofixIneligible) {
      return;
    }

    const plan = repository.readReviewAutofixPlan(reviewAgentId);
    if (!plan || plan.chainStatus !== 'running') {
      return;
    }

    // Only the first pending, unassigned batch may start; anything else means
    // the chain was already progressed (idempotence guard).
    const batch = plan.batches[0];
    if (!batch || batch.index !== 0 || batch.status !== 'pending' || batch.agentId) {
      return;
    }

    const findings = repository.readReviewFindings(reviewAgentId);
    if (!findings) {
      return;
    }
    const assignedFindings = batch.findingIds
      .map((findingId) => findings.find((entry) => entry.id === findingId))
      .filter((entry): entry is ReviewFindingRecord => Boolean(entry));
    if (assignedFindings.length === 0) {
      return;
    }

    const headBranch = agent.review?.headBranch || agent.agentBranch;
    if (!headBranch) {
      return;
    }

    const prompt = buildFixAgentPrompt(assignedFindings, {
      headBranch,
      reviewedSha: plan.snapshot.reviewedSha,
    });

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
          kind: 'automatic',
          sourceReviewAgentId: reviewAgentId,
          findingIds: batch.findingIds,
          batchIndex: batch.index,
        },
      } as Record<string, unknown>);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      batch.status = 'failed';
      plan.chainStatus = 'paused';
      plan.nextBatchIndex = null;
      repository.writeReviewAutofixPlan(reviewAgentId, plan);
      appendLog(
        repository.getLogPath(reviewAgentId),
        `Autofix chain paused — first batch agent creation failed: ${message}`,
      );
      return;
    }

    batch.agentId = fixAgent.agentId;
    batch.status = 'queued';
    plan.nextBatchIndex = plan.batches.length > 1 ? 1 : null;
    repository.writeReviewAutofixPlan(reviewAgentId, plan);

    for (const finding of assignedFindings) {
      finding.fixStatus = 'assigned';
      finding.assignedAgentId = fixAgent.agentId;
    }
    repository.writeReviewFindings(reviewAgentId, findings);

    appendLog(
      repository.getLogPath(reviewAgentId),
      `Autofix batch 0 assigned to fix agent ${fixAgent.agentId} (${batch.findingIds.length} finding(s))`,
    );
    logAutofixEvent('batch.created', {
      reviewAgentId,
      batchIndex: batch.index,
      findingIds: batch.findingIds,
      fixAgentId: fixAgent.agentId,
    });
  }

  /**
   * Finds an existing verification review created for this source review.
   * Looks at both the review metadata (`sourceReviewAgentId`) and the legacy
   * background marker so dedup holds regardless of which field is populated.
   */
  function findExistingVerificationReview(reviewAgentId: string): Agent | undefined {
    return repository.findAll().find(
      (entry) =>
        getAgentMode(entry) === 'review' &&
        (entry.review?.sourceReviewAgentId === reviewAgentId ||
          entry.review?.background === `autofix-verification:${reviewAgentId}`),
    );
  }

  /**
   * Schedules the one verification review for a source review (plan:
   * "Verification review scheduling").
   *
   * Guards before creating:
   * 1. The source review exists and is a review.
   * 2. No related fix agent (autofix metadata pointing at this source review)
   *    is queued/running on the branch — work must drain first.
   * 3. Plan dedup: the plan's verification slot must be free (none/failed), and
   *    no verification agent exists yet. The new review's ID is persisted into
   *    the plan before returning, so repeated invocations cannot duplicate.
   *
   * A manual fix on a verification review's findings schedules another
   * verification review for that review — allowed; it never creates fix
   * batches because `startAutomaticChain` rejects autofix-ineligible reviews.
   *
   * The created review uses normal review behavior but is marked
   * `purpose: 'verification'`, `autofixIneligible: true`, and carries
   * `sourceReviewAgentId` — the primary infinite-loop guard.
   */
  async function scheduleVerificationReview(
    reviewAgentId: string,
    trigger: 'automatic' | 'manual',
  ): Promise<string | null> {
    if (typeof createReviewAgent !== 'function') {
      return null;
    }

    let agent: Agent;
    try {
      agent = repository.getAgent(reviewAgentId);
    } catch {
      return null;
    }
    if (getAgentMode(agent) !== 'review') {
      return null;
    }

    const headBranch = agent.review?.headBranch || agent.agentBranch;
    if (!headBranch) {
      return null;
    }

    // Drain check: related fix agents must all be finished.
    const activeRelated = repository
      .findAll()
      .some(
        (entry) =>
          entry.autofix?.sourceReviewAgentId === reviewAgentId &&
          ACTIVE_FIX_STATUSES.has(entry.status),
      );
    if (activeRelated) {
      return null;
    }

    // Plan dedup + agent dedup.
    const plan = repository.readReviewAutofixPlan(reviewAgentId);
    const existing = findExistingVerificationReview(reviewAgentId);
    if (existing) {
      if (plan && plan.verification.status === 'pending' && !plan.verification.agentId) {
        // Recover from a crash between agent creation and plan persistence.
        plan.verification = { status: 'queued', agentId: existing.agentId };
        repository.writeReviewAutofixPlan(reviewAgentId, plan);
      }
      return existing.agentId;
    }
    if (
      plan &&
      (plan.verification.status === 'queued' ||
        plan.verification.status === 'running' ||
        plan.verification.status === 'completed')
    ) {
      return plan.verification.agentId;
    }

    let verificationAgent: Agent;
    try {
      verificationAgent = createReviewAgent({
        repoId: agent.repoId,
        mode: 'review',
        prompt: '',
        baseBranch: agent.baseBranch || headBranch,
        headBranch,
        background: `autofix-verification:${reviewAgentId}`,
      } as Record<string, unknown>);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendLog(
        repository.getLogPath(reviewAgentId),
        `Autofix verification review creation failed (${trigger}): ${message}`,
      );
      return null;
    }

    // Persist the relationship before another scheduler run can execute.
    const existingReview = verificationAgent.review ?? {
      baseBranch: agent.baseBranch || headBranch,
      headBranch,
    };
    const updatedAgent = repository.update(verificationAgent.agentId, {
      review: {
        ...existingReview,
        baseBranch: existingReview.baseBranch || agent.baseBranch || headBranch,
        headBranch: existingReview.headBranch || headBranch,
        purpose: 'verification',
        autofixIneligible: true,
        sourceReviewAgentId: reviewAgentId,
      },
    });
    if (updatedAgent) {
      verificationAgent = updatedAgent;
    }

    if (plan) {
      plan.verification = { status: 'queued', agentId: verificationAgent.agentId };
      repository.writeReviewAutofixPlan(reviewAgentId, plan);
    }

    appendLog(
      repository.getLogPath(reviewAgentId),
      `Autofix verification review ${verificationAgent.agentId} scheduled (${trigger})`,
    );
    logAutofixEvent('verification.scheduled', {
      reviewAgentId,
      fixAgentId: verificationAgent.agentId,
      detail: trigger,
    });
    return verificationAgent.agentId;
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

  /**
   * Resumes a paused automatic chain (plan: "Resume behavior" and the
   * `/autofix/resume` endpoint).
   *
   * Validation:
   * 1. Plan exists (NOT_FOUND otherwise).
   * 2. Chain is `paused` (VALIDATION_ERROR otherwise).
   * 3. No automatic fix agent for this plan is queued/running (DUPLICATE —
   *    covers duplicate clicks and a restart racing a live worker).
   * 4. A later pending batch exists (VALIDATION_ERROR otherwise).
   *
   * Behavior:
   * 1. Mark failed batches skipped; their findings stay failed (manually
   *    fixable) and are never reassigned.
   * 2. Set the chain to `running` and point `nextBatchIndex` at the next
   *    pending batch.
   * 3. Persist the plan before creating any agent, then create the next
   *    pending batch via `createNextAutomaticBatch` (which marks its findings
   *    assigned and pauses again if creation fails).
   */
  async function resumeAutomaticChain(
    reviewAgentId: string,
  ): Promise<{ batchIndex: number }> {
    if (typeof createBatchAgent !== 'function') {
      throw new CodedError('Automatic chain resume is not available', 'NOT_READY');
    }

    const agent = repository.getAgent(reviewAgentId);
    if (getAgentMode(agent) !== 'review') {
      throw new CodedError('Agent is not a review session', 'INVALID_MODE');
    }

    const plan = repository.readReviewAutofixPlan(reviewAgentId);
    if (!plan) {
      throw new CodedError('No autofix plan exists for this review', 'NOT_FOUND');
    }

    // Duplicate-click guard: any still-active automatic fix agent for this
    // plan means resume work is already in flight — conflict, never a second
    // agent. Checked before the chain status so a click racing a just-resumed
    // (running) chain also rejects with a conflict.
    const activeBatchAgent = repository
      .findAll()
      .find(
        (entry) =>
          entry.autofix?.kind === 'automatic' &&
          entry.autofix.sourceReviewAgentId === reviewAgentId &&
          ACTIVE_FIX_STATUSES.has(entry.status),
      );
    if (activeBatchAgent) {
      throw new CodedError(
        `Automatic fix agent ${activeBatchAgent.agentId} is still active`,
        'DUPLICATE',
      );
    }

    if (plan.chainStatus !== 'paused') {
      throw new CodedError(
        `The automatic chain is ${plan.chainStatus}; resume is only available while paused`,
        'VALIDATION_ERROR',
      );
    }

    // Skip failed work; find the next pending batch. Its findings stay
    // manually fixable — only the batch transitions to skipped.
    let resumed = false;
    let nextPending: AutofixBatchPlan | undefined;
    for (const batch of plan.batches) {
      if (batch.status === 'failed') {
        batch.status = 'skipped';
        resumed = true;
      } else if (batch.status === 'pending' && !batch.agentId) {
        nextPending = batch;
        break;
      }
    }
    if (!nextPending) {
      throw new CodedError('No pending batches remain for this chain', 'VALIDATION_ERROR');
    }

    plan.chainStatus = 'running';
    plan.nextBatchIndex = nextPending.index;
    repository.writeReviewAutofixPlan(reviewAgentId, plan);
    if (resumed) {
      appendLog(
        repository.getLogPath(reviewAgentId),
        `Autofix chain resumed — failed batch(es) skipped, continuing with batch ${nextPending.index}`,
      );
    }

    const created = await createNextAutomaticBatch(reviewAgentId);
    return { batchIndex: created?.batchIndex ?? nextPending.index };
  }

  /**
   * Creates the next pending batch agent for a running chain.
   *
   * Per plan ("Creating automatic batches"):
   * - Reloads the latest plan from disk; chain must still be `running`.
   * - The batch addressed by `nextBatchIndex` must be pending with no agent ID.
   * - Builds the prompt from the assigned findings and creates exactly one
   *   batch agent, then persists the agent ID + queued status and marks the
   *   batch findings assigned.
   * - On creation failure: the batch is marked failed and the chain paused.
   *   Returns null when there is nothing to create.
   */
  async function createNextAutomaticBatch(
    reviewAgentId: string,
  ): Promise<{ batchIndex: number } | null> {
    if (typeof createBatchAgent !== 'function') {
      return null;
    }

    const agent = repository.getAgent(reviewAgentId);
    if (getAgentMode(agent) !== 'review') {
      return null;
    }

    const plan = repository.readReviewAutofixPlan(reviewAgentId);
    if (!plan || plan.chainStatus !== 'running') {
      return null;
    }

    const nextIndex = plan.nextBatchIndex;
    if (nextIndex === null || nextIndex === undefined) {
      return null;
    }
    const batch = plan.batches.find((entry) => entry.index === nextIndex);
    if (!batch || batch.status !== 'pending' || batch.agentId) {
      return null;
    }

    const findings = repository.readReviewFindings(reviewAgentId);
    if (!findings) {
      return null;
    }
    const assignedFindings = batch.findingIds
      .map((findingId) => findings.find((entry) => entry.id === findingId))
      .filter((entry): entry is ReviewFindingRecord => Boolean(entry));
    if (assignedFindings.length === 0) {
      return null;
    }

    const headBranch = agent.review?.headBranch || agent.agentBranch;
    if (!headBranch) {
      return null;
    }

    const prompt = buildFixAgentPrompt(assignedFindings, {
      headBranch,
      reviewedSha: plan.snapshot.reviewedSha,
    });

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
          kind: 'automatic',
          sourceReviewAgentId: reviewAgentId,
          findingIds: batch.findingIds,
          batchIndex: batch.index,
        },
      } as Record<string, unknown>);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      batch.status = 'failed';
      plan.chainStatus = 'paused';
      plan.nextBatchIndex = null;
      repository.writeReviewAutofixPlan(reviewAgentId, plan);
      appendLog(
        repository.getLogPath(reviewAgentId),
        `Autofix chain paused — batch ${batch.index} agent creation failed: ${message}`,
      );
      return null;
    }

    batch.agentId = fixAgent.agentId;
    batch.status = 'queued';
    plan.nextBatchIndex = plan.batches.some((entry) => entry.index > batch.index)
      ? batch.index + 1
      : null;
    repository.writeReviewAutofixPlan(reviewAgentId, plan);

    for (const finding of assignedFindings) {
      finding.fixStatus = 'assigned';
      finding.assignedAgentId = fixAgent.agentId;
    }
    repository.writeReviewFindings(reviewAgentId, findings);

    appendLog(
      repository.getLogPath(reviewAgentId),
      `Autofix batch ${batch.index} assigned to fix agent ${fixAgent.agentId} (${batch.findingIds.length} finding(s))`,
    );
    logAutofixEvent('batch.created', {
      reviewAgentId,
      batchIndex: batch.index,
      findingIds: batch.findingIds,
      fixAgentId: fixAgent.agentId,
    });
    return { batchIndex: batch.index };
  }

  /**
   * Fails the batch's assigned findings when the fix agent record itself is
   * missing after a restart — the assignment can never be recovered, so the
   * findings become manually actionable again.
   */
  function reconcileFindingsForMissingAgent(
    reviewAgentId: string,
    batch: AutofixBatchPlan,
  ): void {
    if (!batch.agentId) {
      return;
    }
    const findings = repository.readReviewFindings(reviewAgentId);
    if (!findings) {
      return;
    }
    let changed = false;
    for (const finding of findings) {
      if (
        batch.findingIds.includes(finding.id) &&
        finding.assignedAgentId === batch.agentId &&
        (finding.fixStatus === 'assigned' || finding.fixStatus === 'fixing')
      ) {
        finding.fixStatus = 'failed';
        changed = true;
      }
    }
    if (changed) {
      repository.writeReviewFindings(reviewAgentId, findings);
    }
  }

  /**
   * Startup reconciliation for a single plan (plan: Phase 7 "Reconcile plans
   * during server startup"). Mutates the plan in place and returns whether the
   * chain needs re-enqueueing. Rules:
   * - Queued agent record still exists: retain the assignment (queued batch).
   * - Queued/running batch whose agent record is missing: mark the batch
   *   failed and pause the chain.
   * - Batch stuck in `running` with no live worker: derive the outcome from
   *   the agent record — completed+pushed → completed, otherwise failed — and
   *   pause the chain (creating later batches is the caller's decision via
   *   resume, never automatic here).
   */
  function reconcileAutofixPlan(
    reviewAgentId: string,
    plan: ReviewAutofixPlan,
  ): { needsResume: boolean } {
    let changed = false;
    let needsResume = false;

    if (plan.chainStatus === 'running' && plan.nextBatchIndex === null) {
      // A running chain with nothing left to create is waiting on its active
      // agent; whether that agent exists decides the outcome below.
      const activeBatch = plan.batches.find(
        (entry) => entry.status === 'queued' || entry.status === 'running',
      );
      if (!activeBatch) {
        // Nothing active and nothing to create: the chain cannot progress.
        plan.chainStatus = 'paused';
        changed = true;
      }
    }

    for (const batch of plan.batches) {
      if (batch.status !== 'queued' && batch.status !== 'running') {
        continue;
      }

      const fixAgent = batch.agentId ? repository.findById(batch.agentId) : undefined;
      if (!fixAgent) {
        // Missing agent record: nothing to retry — pause for manual/resume.
        batch.status = 'failed';
        plan.chainStatus = 'paused';
        plan.nextBatchIndex = null;
        changed = true;
        reconcileFindingsForMissingAgent(reviewAgentId, batch);
        logAutofixEvent('startup.batch_failed', {
          reviewAgentId,
          batchIndex: batch.index,
          findingIds: batch.findingIds,
          fixAgentId: batch.agentId,
          detail: 'fix agent record missing after restart',
        });
        appendLog(
          repository.getLogPath(reviewAgentId),
          `Autofix batch ${batch.index} failed after restart — fix agent record missing`,
        );
        continue;
      }

      if (fixAgent.status === 'queued') {
        // Queued agent still exists — retain the assignment and re-enqueue.
        if (batch.status === 'running') {
          batch.status = 'queued';
          changed = true;
        }
        needsResume = true;
        logAutofixEvent('startup.batch.requeued', {
          reviewAgentId,
          batchIndex: batch.index,
          findingIds: batch.findingIds,
          fixAgentId: fixAgent.agentId,
        });
        continue;
      }

      // No live worker can exist for a queued/running batch after a restart
      // (restoreOnStartup failed in-progress agents). Derive the outcome.
      const succeeded = fixAgent.status === 'completed' && fixAgent.pushed === true;
      batch.status = succeeded ? 'completed' : 'failed';
      plan.chainStatus = 'paused';
      changed = true;
      logAutofixEvent('startup.batch.reconciled', {
        reviewAgentId,
        batchIndex: batch.index,
        findingIds: batch.findingIds,
        fixAgentId: fixAgent.agentId,
        detail: `derived ${batch.status} from agent status ${fixAgent.status}`,
      });
      appendLog(
        repository.getLogPath(reviewAgentId),
        `Autofix batch ${batch.index} reconciled after restart — ${batch.status} (agent ${fixAgent.agentId} ${fixAgent.status}, pushed=${fixAgent.pushed === true})`,
      );
    }

    if (changed) {
      repository.writeReviewAutofixPlan(reviewAgentId, plan);
    }
    return { needsResume };
  }

  /**
   * Derives the startup outcome for one fix agent's assigned findings: fixed
   * when the agent completed with a push, failed when the agent is stopped and
   * no live worker exists, and untouched while the agent is still queued (its
   * batch will run after re-enqueue). Findings assigned to other/unknown
   * agents are left alone.
   */
  function reconcileFindingsForFixAgent(fixAgent: Agent): void {
    const autofix = fixAgent.autofix;
    if (!autofix) {
      return;
    }
    const reviewAgentId = autofix.sourceReviewAgentId;
    const findings = repository.readReviewFindings(reviewAgentId);
    if (!findings) {
      return;
    }
    const succeeded = fixAgent.status === 'completed' && fixAgent.pushed === true;
    let changed = false;
    for (const finding of findings) {
      if (!autofix.findingIds.includes(finding.id) || finding.assignedAgentId !== fixAgent.agentId) {
        continue;
      }
      if (finding.fixStatus === 'assigned' || finding.fixStatus === 'fixing') {
        if (fixAgent.status === 'queued') {
          // Still queued: restoreOnStartup re-enqueues it; keep assigned.
          continue;
        }
        finding.fixStatus = succeeded ? 'fixed' : 'failed';
        if (succeeded) {
          finding.fixedAt = new Date().toISOString();
        }
        changed = true;
      }
    }
    if (changed) {
      repository.writeReviewFindings(reviewAgentId, findings);
      logAutofixEvent('startup.findings.reconciled', {
        reviewAgentId,
        findingIds: autofix.findingIds,
        fixAgentId: fixAgent.agentId,
        detail: succeeded ? 'fixed' : 'failed (manually actionable)',
      });
    }
  }

  /**
   * Reconciles every persisted autofix plan after a server restart. See the
   * interface doc for the rules. Never creates agents — a chain whose queued
   * agent survives restart continues only because restoreOnStartup re-enqueues
   * queued agents; the plan stays `running` for that path.
   */
  function reconcileAutofixPlansOnStartup(): void {
    for (const reviewAgent of repository.findAll()) {
      if (getAgentMode(reviewAgent) !== 'review') {
        continue;
      }
      const plan = repository.readReviewAutofixPlan(reviewAgent.agentId);
      if (!plan || plan.chainStatus === 'disabled' || plan.chainStatus === 'completed') {
        continue;
      }

      reconcileAutofixPlan(reviewAgent.agentId, plan);

      // Derive finding outcomes for any fix agent that was in flight during
      // the interruption so its findings are not stuck on assigned/fixing.
      for (const fixAgent of repository.findAll()) {
        if (
          fixAgent.autofix?.sourceReviewAgentId !== reviewAgent.agentId ||
          !ACTIVE_FIX_TERMINAL_OR_STOPPED.has(fixAgent.status)
        ) {
          continue;
        }
        reconcileFindingsForFixAgent(fixAgent);
      }
    }
  }

  /**
   * Worker start lifecycle: flip assigned findings to `fixing` and a queued
   * automatic batch to `running`. No-op for agents without autofix metadata.
   */
  function handleFixAgentStarted(fixAgentId: string): void {
    let fixAgent: Agent;
    try {
      fixAgent = repository.getAgent(fixAgentId);
    } catch {
      return;
    }
    const autofix = fixAgent.autofix;
    if (!autofix) {
      return;
    }

    const reviewAgentId = autofix.sourceReviewAgentId;
    const findings = repository.readReviewFindings(reviewAgentId);
    if (!findings) {
      return;
    }
    let changed = false;
    for (const finding of findings) {
      if (autofix.findingIds.includes(finding.id) && finding.assignedAgentId === fixAgentId) {
        finding.fixStatus = 'fixing';
        changed = true;
      }
    }
    if (changed) {
      repository.writeReviewFindings(reviewAgentId, findings);
    }

    if (autofix.kind === 'automatic') {
      const plan = repository.readReviewAutofixPlan(reviewAgentId);
      if (plan) {
        const batch = plan.batches.find(
          (entry) =>
            entry.agentId === fixAgentId &&
            (entry.status === 'queued' || entry.status === 'running'),
        );
        if (batch) {
          batch.status = 'running';
          repository.writeReviewAutofixPlan(reviewAgentId, plan);
          appendLog(
            repository.getLogPath(reviewAgentId),
            `Autofix batch ${batch.index} running (fix agent ${fixAgentId})`,
          );
          logAutofixEvent('batch.running', {
            reviewAgentId,
            batchIndex: batch.index,
            findingIds: autofix.findingIds,
            fixAgentId,
          });
        }
      }
    }
  }

  /**
   * Resolves the GitHub thread linked to one fixed finding without throwing —
   * used by the fix-agent exit path so resolution failures never change the
   * coding outcome. Mirrors retryFindingResolution validation, but tolerates
   * findings without a linked comment/thread (resolution stays not_applicable).
   */
  async function resolveFindingThreadAfterFix(
    reviewAgentId: string,
    finding: ReviewFindingRecord,
  ): Promise<void> {
    const config = configRepository.load();
    try {
      if (finding.github.resolutionStatus === 'resolved') {
        return;
      }
      let threadId = finding.github.threadId;
      if (!threadId) {
        if (typeof finding.github.commentId !== 'number') {
          return;
        }
        const reviewAgent = repository.getAgent(reviewAgentId);
        const prNumber = reviewAgent.review?.prNumber ?? null;
        if (typeof prNumber !== 'number') {
          finding.github.resolutionStatus = 'not_applicable';
          finding.github.resolutionError = null;
          return;
        }
        const repo = repoManager.getRepo(reviewAgent.repoId);
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
      finding.github.resolutionStatus = 'resolved';
      finding.github.resolutionError = null;
      finding.github.resolvedAt = new Date().toISOString();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      finding.github.resolutionStatus = 'failed';
      finding.github.resolutionError = message;
    }
  }

  /**
   * Worker exit lifecycle for fix agents (autofix metadata present).
   *
   * Completed + pushed: findings fixed, host resolves linked threads
   * (failures persisted, never thrown), batch completed, and the next pending
   * batch is created — or the chain completes when no batches remain.
   * Failed/cancelled/completed-without-push: findings failed (manually
   * actionable), batch failed, chain paused; no later batch is created.
   */
  async function handleFixAgentFinished(fixAgentId: string): Promise<void> {
    let fixAgent: Agent;
    try {
      fixAgent = repository.getAgent(fixAgentId);
    } catch {
      return;
    }
    const autofix = fixAgent.autofix;
    if (!autofix) {
      return;
    }

    const reviewAgentId = autofix.sourceReviewAgentId;
    const findings = repository.readReviewFindings(reviewAgentId);
    if (!findings) {
      return;
    }
    const assignedFindings = findings.filter((entry) =>
      autofix.findingIds.includes(entry.id) && entry.assignedAgentId === fixAgentId,
    );

    const succeeded = fixAgent.status === 'completed' && fixAgent.pushed === true;

    if (succeeded) {
      // Plan invariant 10: persist the fixed state before the async GitHub
      // resolution attempts, so a crash leaves recoverable state.
      for (const finding of assignedFindings) {
        finding.fixStatus = 'fixed';
        finding.fixedAt = new Date().toISOString();
      }
      repository.writeReviewFindings(reviewAgentId, findings);
      logAutofixEvent('findings.fixed', {
        reviewAgentId,
        findingIds: assignedFindings.map((entry) => entry.id),
        fixAgentId,
      });

      for (const finding of assignedFindings) {
        await resolveFindingThreadAfterFix(reviewAgentId, finding);
      }
      repository.writeReviewFindings(reviewAgentId, findings);
    } else {
      for (const finding of assignedFindings) {
        finding.fixStatus = 'failed';
      }
      repository.writeReviewFindings(reviewAgentId, findings);
    }

    if (autofix.kind !== 'automatic') {
      appendLog(
        repository.getLogPath(reviewAgentId),
        succeeded
          ? `Manual fix agent ${fixAgentId} completed — ${assignedFindings.length} finding(s) fixed`
          : `Manual fix agent ${fixAgentId} did not push — finding(s) manually fixable again`,
      );
      if (succeeded) {
        // Manual fixes coalesce: schedule only once every related fix agent
        // for this source review has drained (the drain guard inside the
        // scheduler rejects while any sibling fix agent is still active).
        try {
          await scheduleVerificationReview(reviewAgentId, 'manual');
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          appendLog(
            repository.getLogPath(reviewAgentId),
            `Warning: scheduling the manual-fix verification review failed — ${message}`,
          );
        }
      }
      return;
    }

    const plan = repository.readReviewAutofixPlan(reviewAgentId);
    if (!plan) {
      return;
    }
    const batch = plan.batches.find((entry) => entry.agentId === fixAgentId);
    if (!batch) {
      return;
    }

    if (succeeded) {
      batch.status = 'completed';
      const laterPending = plan.batches.find(
        (entry) => entry.index > batch.index && entry.status === 'pending' && !entry.agentId,
      );
      if (laterPending) {
        plan.nextBatchIndex = laterPending.index;
        repository.writeReviewAutofixPlan(reviewAgentId, plan);
        await createNextAutomaticBatch(reviewAgentId);
      } else {
        plan.chainStatus = 'completed';
        plan.nextBatchIndex = null;
        plan.verification = { status: 'pending', agentId: null };
        repository.writeReviewAutofixPlan(reviewAgentId, plan);
        appendLog(
          repository.getLogPath(reviewAgentId),
          `Autofix chain completed — verification review pending`,
        );
        try {
          await scheduleVerificationReview(reviewAgentId, 'automatic');
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          appendLog(
            repository.getLogPath(reviewAgentId),
            `Warning: scheduling the verification review failed — ${message}`,
          );
        }
      }
    } else {
      batch.status = 'failed';
      plan.chainStatus = 'paused';
      plan.nextBatchIndex = null;
      repository.writeReviewAutofixPlan(reviewAgentId, plan);
      appendLog(
        repository.getLogPath(reviewAgentId),
        `Autofix chain paused — batch ${batch.index} fix agent ${fixAgentId} finished without a successful push`,
      );
      logAutofixEvent('chain.paused', {
        reviewAgentId,
        batchIndex: batch.index,
        findingIds: autofix.findingIds,
        fixAgentId,
        detail: 'fix agent finished without a successful push',
      });
    }
  }

  return {
    createManualFix,
    startAutomaticChain,
    resumeAutomaticChain,
    retryFindingResolution,
    handleFixAgentStarted,
    handleFixAgentFinished,
    scheduleVerificationReview,
    reconcileAutofixPlansOnStartup,
  };
}