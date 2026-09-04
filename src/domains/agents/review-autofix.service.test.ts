import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createJsonStore } from '../../lib/json-store';
import type { Agent, AutofixBatchPlan, ReviewFindingRecord } from '../../types';
import { CodedError } from '../../types';
import type { AgentRepository } from './agent.repository';
import { createAgentRepository } from './agent.repository';
import { createReviewAutofixService } from './review-autofix.service';
import type { ConfigRepository } from '../config/config.repository';
import type { RepoService } from '../repos/repo.service';
import type { GithubAppService } from '../../services/github-app';

const rootDirs: string[] = [];

afterEach(() => {
  while (rootDirs.length > 0) {
    const root = rootDirs.pop()!;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

interface TestContext {
  repository: AgentRepository;
  service: ReturnType<typeof createReviewAutofixService>;
  calls: { lookups: number[]; resolved: string[]; created: Array<Record<string, unknown>> };
  lookupResult: { threadId: string; isResolved: boolean } | null;
  resolveError: Error | null;
  createAgentError: Error | null;
  branches: string[] | null;
  /** Counter for sequentially generated fix agent IDs (fix1, fix2, …). */
  nextFixAgentId: number;
  /** When set, review-agent creation throws (verification scheduling test). */
  createReviewAgentError: Error | null;
  /** True when the service factory omitted the review-agent factory. */
  reviewAgentFactoryMissing: boolean;
}

function finding(overrides: Partial<ReviewFindingRecord> = {}): ReviewFindingRecord {
  return {
    id: 'review1:finding:0',
    ordinal: 0,
    severity: 'high',
    category: 'correctness',
    path: 'src/a.ts',
    startLine: 1,
    endLine: 2,
    content: 'finding',
    existingCode: null,
    suggestionCode: null,
    reviewedSha: null,
    fixStatus: 'fixed',
    assignedAgentId: null,
    fixedAt: '2026-09-04T00:00:00.000Z',
    github: {
      reviewId: '1',
      commentId: 42,
      commentUrl: 'https://example.com/comment/42',
      threadId: null,
      resolutionStatus: 'failed',
      resolutionError: 'previous attempt failed',
      resolvedAt: null,
    },
    ...overrides,
  };
}

function setup(options: {
  findings: ReviewFindingRecord[] | null;
  prNumber?: number | null;
}): TestContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-autofix-'));
  rootDirs.push(root);
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const agentsStore = createJsonStore<{ agents: Agent[] }>(
    path.join(dataDir, 'agents.json'),
    { agents: [] },
    fs,
  );
  const repository = createAgentRepository({
    dataDir,
    workspaceRoot: path.join(root, 'workspaces'),
    agentsStore,
    fs,
    path,
  });
  const agent: Agent = {
    agentId: 'review1',
    workspaceId: 'ws1',
    repoId: 'r1',
    mode: 'review',
    prompt: '',
    systemPrompt: null,
    baseBranch: 'main',
    agentBranch: 'feature',
    commitMessage: '',
    push: false,
    pushOnFailure: false,
    model: null,
    status: 'completed',
    commitSha: null,
    pushed: false,
    filesChanged: null,
    createdAt: '2026-09-04T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    branch: null,
    error: null,
    result: null,
    review: {
      baseBranch: 'main',
      headBranch: 'feature',
      prNumber: options.prNumber ?? 7,
      headSha: null,
    },
  };
  repository.save(agent);
  if (options.findings) {
    repository.writeReviewFindings('review1', options.findings);
  }

  const calls = {
    lookups: [] as number[],
    resolved: [] as string[],
    created: [] as Array<Record<string, unknown>>,
  };
  const ctx: TestContext = {
    repository,
    service: null as unknown as ReturnType<typeof createReviewAutofixService>,
    calls,
    lookupResult: null,
    resolveError: null,
    createAgentError: null,
    branches: null,
    nextFixAgentId: 0,
    createReviewAgentError: null,
    reviewAgentFactoryMissing: false,
  };

  const repoManager = {
    getRepo: () => ({ owner: 'acme', name: 'demo' }),
  } as unknown as RepoService;

  const configRepository = {
    load: () => ({}),
    save: (partial: unknown) => partial,
    toPublic: (config: unknown) => config,
  } as unknown as ConfigRepository;

  const githubApp = {
    findReviewThreadIdForComment: async (
      _config: unknown,
      _owner: string,
      _repo: string,
      _prNumber: number,
      commentId: number,
    ) => {
      calls.lookups.push(commentId);
      if (ctx.lookupResult === null) {
        throw new Error('thread lookup failed');
      }
      return ctx.lookupResult;
    },
    resolvePullRequestReviewThread: async (_config: unknown, threadId: string) => {
      if (ctx.resolveError) {
        throw ctx.resolveError;
      }
      calls.resolved.push(threadId);
      return { threadId, isResolved: true };
    },
    fetchRepositoryBranches: async () => {
      if (ctx.branches === null) {
        throw new Error('branch listing failed');
      }
      return ctx.branches;
    },
  } as unknown as GithubAppService;

  ctx.service = createReviewAutofixService({
    repository,
    repoManager,
    configRepository,
    githubApp,
    createBatchAgent: (body) => {
      calls.created.push(body);
      if (ctx.createAgentError) {
        throw ctx.createAgentError;
      }
      ctx.nextFixAgentId += 1;
      const agentId = `fix${ctx.nextFixAgentId}`;
      const fixAgent = {
        agentId,
        workspaceId: `ws-${agentId}`,
        repoId: body.repoId as string,
        mode: 'batch',
        prompt: body.prompt as string,
        systemPrompt: null,
        baseBranch: body.baseBranch as string,
        agentBranch: body.agentBranch as string,
        useExistingBranch: true,
        commitMessage: '',
        push: true,
        pushOnFailure: false,
        model: null,
        status: 'queued',
        commitSha: null,
        pushed: false,
        filesChanged: null,
        createdAt: '2026-09-04T00:00:00.000Z',
        startedAt: null,
        finishedAt: null,
        branch: null,
        error: null,
        result: null,
        autofix: body.autofix as Agent['autofix'],
      } as unknown as Agent;
      // Persist the created fix agent so lifecycle hooks can read it.
      repository.save(fixAgent);
      return fixAgent;
    },
    ...(ctx.reviewAgentFactoryMissing
      ? {}
      : {
          createReviewAgent: (body: Record<string, unknown>) => {
            calls.created.push({ ...body, __kind: 'review' });
            if (ctx.createReviewAgentError) {
              throw ctx.createReviewAgentError;
            }
            const agentId = `verify${calls.created.filter((entry) => entry.__kind === 'review').length}`;
            const reviewAgent = {
              agentId,
              workspaceId: `ws-${agentId}`,
              repoId: body.repoId as string,
              mode: 'review',
              prompt: '',
              systemPrompt: null,
              baseBranch: body.baseBranch as string,
              agentBranch: body.headBranch as string,
              useExistingBranch: true,
              commitMessage: '',
              push: false,
              pushOnFailure: false,
              model: null,
              status: 'queued',
              commitSha: null,
              pushed: false,
              filesChanged: null,
              createdAt: '2026-09-04T00:00:00.000Z',
              startedAt: null,
              finishedAt: null,
              branch: null,
              error: null,
              result: null,
              review: {
                baseBranch: body.baseBranch ?? null,
                headBranch: body.headBranch ?? null,
                background: body.background ?? null,
              },
            } as unknown as Agent;
            repository.save(reviewAgent);
            return reviewAgent;
          },
        }),
  });
  return ctx;
}

describe('retryFindingResolution', () => {
  it('resolves the thread and marks the finding resolved', async () => {
    const ctx = setup({ findings: [finding()] });
    ctx.lookupResult = { threadId: 'thread-1', isResolved: false };

    const result = await ctx.service.retryFindingResolution('review1', 'review1:finding:0');

    assert.deepEqual(ctx.calls.lookups, [42]);
    assert.deepEqual(ctx.calls.resolved, ['thread-1']);
    assert.equal(result.github.resolutionStatus, 'resolved');
    assert.equal(result.github.resolutionError, null);
    assert.ok(result.github.resolvedAt);
    const persisted = ctx.repository.readReviewFindings('review1');
    assert.equal(persisted?.[0].github.threadId, 'thread-1');
    assert.equal(persisted?.[0].github.resolutionStatus, 'resolved');
  });

  it('uses the cached thread ID without a lookup', async () => {
    const ctx = setup({
      findings: [finding({ github: { ...finding().github, threadId: 'thread-cached' } })],
    });

    const result = await ctx.service.retryFindingResolution('review1', 'review1:finding:0');

    assert.deepEqual(ctx.calls.lookups, []);
    assert.deepEqual(ctx.calls.resolved, ['thread-cached']);
    assert.equal(result.github.resolutionStatus, 'resolved');
  });

  it('treats resolution failure as a failed finding response, not a throw', async () => {
    const ctx = setup({ findings: [finding()] });
    ctx.lookupResult = { threadId: 'thread-1', isResolved: false };
    ctx.resolveError = new Error('GitHub API is down');

    const result = await ctx.service.retryFindingResolution('review1', 'review1:finding:0');

    assert.equal(result.github.resolutionStatus, 'failed');
    assert.equal(result.github.resolutionError, 'GitHub API is down');
    assert.equal(result.github.resolvedAt, null);
    const persisted = ctx.repository.readReviewFindings('review1');
    assert.equal(persisted?.[0].github.resolutionStatus, 'failed');
  });

  it('persists lookup failure without resolving', async () => {
    const ctx = setup({ findings: [finding()] });
    ctx.lookupResult = null;

    const result = await ctx.service.retryFindingResolution('review1', 'review1:finding:0');

    assert.deepEqual(ctx.calls.resolved, []);
    assert.equal(result.github.resolutionStatus, 'failed');
    assert.match(result.github.resolutionError ?? '', /thread lookup failed/);
  });

  it('rejects a missing review agent', async () => {
    const ctx = setup({ findings: [finding()] });
    await assert.rejects(
      () => ctx.service.retryFindingResolution('missing', 'review1:finding:0'),
      (err: unknown) => err instanceof CodedError && err.code === 'NOT_FOUND',
    );
  });

  it('rejects an unknown finding', async () => {
    const ctx = setup({ findings: [finding()] });
    await assert.rejects(
      () => ctx.service.retryFindingResolution('review1', 'review1:finding:99'),
      (err: unknown) => err instanceof CodedError && err.code === 'NOT_FOUND',
    );
  });

  it('rejects a finding that is not fixed', async () => {
    const ctx = setup({ findings: [finding({ fixStatus: 'available' })] });
    await assert.rejects(
      () => ctx.service.retryFindingResolution('review1', 'review1:finding:0'),
      (err: unknown) => err instanceof CodedError && err.code === 'VALIDATION_ERROR',
    );
  });

  it('rejects a finding without a comment or thread', async () => {
    const ctx = setup({
      findings: [
        finding({
          github: { ...finding().github, commentId: null, threadId: null },
        }),
      ],
    });
    await assert.rejects(
      () => ctx.service.retryFindingResolution('review1', 'review1:finding:0'),
      (err: unknown) => err instanceof CodedError && err.code === 'VALIDATION_ERROR',
    );
  });

  it('rejects retry when resolution is not pending or failed', async () => {
    const ctx = setup({
      findings: [
        finding({
          github: { ...finding().github, resolutionStatus: 'resolved' },
        }),
      ],
    });
    await assert.rejects(
      () => ctx.service.retryFindingResolution('review1', 'review1:finding:0'),
      (err: unknown) => err instanceof CodedError && err.code === 'VALIDATION_ERROR',
    );
  });

  it('rejects retry when structured findings are missing', async () => {
    const ctx = setup({ findings: null });
    await assert.rejects(
      () => ctx.service.retryFindingResolution('review1', 'review1:finding:0'),
      (err: unknown) => err instanceof CodedError && err.code === 'NOT_FOUND',
    );
  });
});

describe('createManualFix', () => {
  function availableFinding(overrides: Partial<ReviewFindingRecord> = {}): ReviewFindingRecord {
    return finding({
      fixStatus: 'available',
      assignedAgentId: null,
      fixedAt: null,
      reviewedSha: 'sha-old',
      ...overrides,
    });
  }

  it('creates one batch agent, marks the finding assigned, and returns staleness', async () => {
    const ctx = setup({ findings: [availableFinding()] });
    ctx.branches = ['feature'];
    ctx.repository.update('review1', {
      review: { baseBranch: 'main', headBranch: 'feature', prNumber: 7, headSha: 'sha-new' },
    });

    const result = await ctx.service.createManualFix('review1', 'review1:finding:0');

    assert.deepEqual(ctx.calls.created.length, 1);
    const body = ctx.calls.created[0]!;
    assert.equal(body.mode, 'batch');
    assert.equal(body.repoId, 'r1');
    assert.equal(body.agentBranch, 'feature');
    assert.equal(body.useExistingBranch, true);
    assert.equal(body.push, true);
    assert.deepEqual((body.autofix as { kind: string }).kind, 'manual');
    assert.deepEqual((body.autofix as { findingIds: string[] }).findingIds, ['review1:finding:0']);
    assert.equal((body.autofix as { sourceReviewAgentId: string }).sourceReviewAgentId, 'review1');
    assert.match(body.prompt as string, /Assigned findings/);
    assert.match(body.prompt as string, /review1:finding:0/);

    assert.equal(result.agent.agentId, 'fix1');
    assert.equal(result.finding.fixStatus, 'assigned');
    assert.equal(result.finding.assignedAgentId, 'fix1');
    assert.equal(result.staleReview, true);

    const persisted = ctx.repository.readReviewFindings('review1');
    assert.equal(persisted?.[0].fixStatus, 'assigned');
    assert.equal(persisted?.[0].assignedAgentId, 'fix1');
  });

  it('reports no staleness when the reviewed SHA matches the current head', async () => {
    const ctx = setup({ findings: [availableFinding()] });
    ctx.branches = ['feature'];

    const result = await ctx.service.createManualFix('review1', 'review1:finding:0');

    assert.equal(result.staleReview, false);
  });

  it('rejects a second manual fix while the finding is assigned (conflict)', async () => {
    const ctx = setup({ findings: [availableFinding()] });
    ctx.branches = ['feature'];
    await ctx.service.createManualFix('review1', 'review1:finding:0');

    await assert.rejects(
      () => ctx.service.createManualFix('review1', 'review1:finding:0'),
      (err: unknown) => err instanceof CodedError && err.code === 'DUPLICATE',
    );
    assert.deepEqual(ctx.calls.created.length, 1);
  });

  it('rejects a fixing finding with a conflict', async () => {
    const ctx = setup({ findings: [availableFinding({ fixStatus: 'fixing' })] });
    ctx.branches = ['feature'];

    await assert.rejects(
      () => ctx.service.createManualFix('review1', 'review1:finding:0'),
      (err: unknown) => err instanceof CodedError && err.code === 'DUPLICATE',
    );
  });

  it('allows a failed finding to be manually fixed again', async () => {
    const ctx = setup({ findings: [availableFinding({ fixStatus: 'failed' })] });
    ctx.branches = ['feature'];

    const result = await ctx.service.createManualFix('review1', 'review1:finding:0');

    assert.equal(result.finding.fixStatus, 'assigned');
    assert.deepEqual(ctx.calls.created.length, 1);
  });

  it('rejects when the head branch no longer exists', async () => {
    const ctx = setup({ findings: [availableFinding()] });
    ctx.branches = ['other'];

    await assert.rejects(
      () => ctx.service.createManualFix('review1', 'review1:finding:0'),
      (err: unknown) =>
        err instanceof CodedError && err.code === 'VALIDATION_ERROR' && /no longer exists/.test(err.message),
    );
    assert.deepEqual(ctx.calls.created, []);
    const persisted = ctx.repository.readReviewFindings('review1');
    assert.equal(persisted?.[0].fixStatus, 'available');
  });

  it('leaves the finding unassigned when agent creation fails', async () => {
    const ctx = setup({ findings: [availableFinding()] });
    ctx.branches = ['feature'];
    ctx.createAgentError = new Error('queue is full');

    await assert.rejects(
      () => ctx.service.createManualFix('review1', 'review1:finding:0'),
      (err: unknown) => err instanceof CodedError && err.code === 'VALIDATION_ERROR',
    );
    const persisted = ctx.repository.readReviewFindings('review1');
    assert.equal(persisted?.[0].fixStatus, 'available');
    assert.equal(persisted?.[0].assignedAgentId, null);
  });

  it('rejects a non-review agent', async () => {
    const ctx = setup({ findings: [availableFinding()] });
    ctx.repository.save({
      ...(ctx.repository.findById('review1') as Agent),
      agentId: 'batch1',
      mode: 'batch',
      prompt: 'work',
    });
    ctx.branches = ['feature'];

    await assert.rejects(
      () => ctx.service.createManualFix('batch1', 'review1:finding:0'),
      (err: unknown) => err instanceof CodedError && err.code === 'INVALID_MODE',
    );
  });

  it('rejects when structured findings are missing', async () => {
    const ctx = setup({ findings: null });
    ctx.branches = ['feature'];

    await assert.rejects(
      () => ctx.service.createManualFix('review1', 'review1:finding:0'),
      (err: unknown) => err instanceof CodedError && err.code === 'NOT_FOUND',
    );
  });

  it('rejects an unknown finding', async () => {
    const ctx = setup({ findings: [availableFinding()] });
    ctx.branches = ['feature'];

    await assert.rejects(
      () => ctx.service.createManualFix('review1', 'review1:finding:99'),
      (err: unknown) => err instanceof CodedError && err.code === 'NOT_FOUND',
    );
  });

  it('rejects when the branch listing fails', async () => {
    const ctx = setup({ findings: [availableFinding()] });
    ctx.branches = null;

    await assert.rejects(
      () => ctx.service.createManualFix('review1', 'review1:finding:0'),
      (err: unknown) => err instanceof CodedError && err.code === 'VALIDATION_ERROR',
    );
  });
});

describe('startAutomaticChain', () => {
  function automaticFinding(ordinal: number): ReviewFindingRecord {
    return finding({
      id: `review1:finding:${ordinal}`,
      ordinal,
      severity: 'high',
      fixStatus: 'available',
      assignedAgentId: null,
      fixedAt: null,
    });
  }

  function writePlan(
    repository: AgentRepository,
    plan: {
      chainStatus?: string;
      firstBatch?: { status: AutofixBatchPlan['status']; agentId: string | null };
    },
  ): void {
    const batch: AutofixBatchPlan = {
      index: 0,
      findingIds: ['review1:finding:0'],
      agentId: null,
      status: 'pending',
      ...(plan.firstBatch ?? {}),
    };
    repository.writeReviewAutofixPlan('review1', {
      schemaVersion: 1,
      snapshot: {
        severityThreshold: 'high',
        maxFindingsPerBatch: 5,
        reviewedSha: 'sha-old',
        baseBranch: 'main',
        headBranch: 'feature',
        prNumber: 7,
        snapshottedAt: '2026-09-04T00:00:00.000Z',
      },
      chainStatus: (plan.chainStatus ?? 'running') as never,
      batches: [batch],
      nextBatchIndex: 0,
      verification: { status: 'none', agentId: null },
    });
  }

  it('creates one automatic batch agent and marks its findings assigned', async () => {
    const ctx = setup({ findings: [automaticFinding(0)] });
    writePlan(ctx.repository, {});

    await ctx.service.startAutomaticChain('review1');

    assert.equal(ctx.calls.created.length, 1);
    const body = ctx.calls.created[0]!;
    assert.equal(body.mode, 'batch');
    assert.equal(body.repoId, 'r1');
    assert.equal(body.agentBranch, 'feature');
    assert.equal(body.baseBranch, 'main');
    assert.equal(body.useExistingBranch, true);
    assert.equal(body.push, true);
    assert.deepEqual((body.autofix as { kind: string }).kind, 'automatic');
    assert.deepEqual((body.autofix as { findingIds: string[] }).findingIds, [
      'review1:finding:0',
    ]);
    assert.equal((body.autofix as { sourceReviewAgentId: string }).sourceReviewAgentId, 'review1');
    assert.equal((body.autofix as { batchIndex: number }).batchIndex, 0);
    assert.match(body.prompt as string, /Assigned findings/);
    assert.match(body.prompt as string, /review1:finding:0/);

    const plan = ctx.repository.readReviewAutofixPlan('review1');
    assert.equal(plan?.batches[0].agentId, 'fix1');
    assert.equal(plan?.batches[0].status, 'queued');
    const persisted = ctx.repository.readReviewFindings('review1');
    assert.equal(persisted?.[0].fixStatus, 'assigned');
    assert.equal(persisted?.[0].assignedAgentId, 'fix1');
  });

  it('is a no-op when the plan is missing', async () => {
    const ctx = setup({ findings: [automaticFinding(0)] });

    await ctx.service.startAutomaticChain('review1');

    assert.deepEqual(ctx.calls.created, []);
  });

  it('is a no-op when the chain is not running', async () => {
    const ctx = setup({ findings: [automaticFinding(0)] });
    writePlan(ctx.repository, { chainStatus: 'paused' });

    await ctx.service.startAutomaticChain('review1');

    assert.deepEqual(ctx.calls.created, []);
  });

  it('is a no-op when the first batch already has an agent (idempotence)', async () => {
    const ctx = setup({ findings: [automaticFinding(0)] });
    writePlan(ctx.repository, { firstBatch: { status: 'queued', agentId: 'existing' } });

    await ctx.service.startAutomaticChain('review1');

    assert.deepEqual(ctx.calls.created, []);
  });

  it('is a no-op for a verification-style plan with no pending batches', async () => {
    const ctx = setup({ findings: [automaticFinding(0)] });
    writePlan(ctx.repository, { firstBatch: { status: 'completed', agentId: 'done' } });

    await ctx.service.startAutomaticChain('review1');

    assert.deepEqual(ctx.calls.created, []);
  });

  it('pauses the chain and marks the batch failed when agent creation throws', async () => {
    const ctx = setup({ findings: [automaticFinding(0)] });
    writePlan(ctx.repository, {});
    ctx.createAgentError = new Error('queue is full');

    await ctx.service.startAutomaticChain('review1');

    assert.equal(ctx.calls.created.length, 1);
    const plan = ctx.repository.readReviewAutofixPlan('review1');
    assert.equal(plan?.chainStatus, 'paused');
    assert.equal(plan?.batches[0].status, 'failed');
    assert.equal(plan?.batches[0].agentId, null);
    // Findings stay manually actionable.
    const persisted = ctx.repository.readReviewFindings('review1');
    assert.equal(persisted?.[0].fixStatus, 'available');
    assert.equal(persisted?.[0].assignedAgentId, null);
  });
});

describe('resumeAutomaticChain', () => {
  function resumeFinding(ordinal: number): ReviewFindingRecord {
    return finding({
      id: `review1:finding:${ordinal}`,
      ordinal,
      severity: 'high',
      fixStatus: 'available',
      assignedAgentId: null,
      fixedAt: null,
    });
  }

  function writeMultiBatchPlan(
    repository: AgentRepository,
    options: {
      batches: Array<{ index: number; agentId: string | null; status: AutofixBatchPlan['status'] }>;
      chainStatus: 'running' | 'paused' | 'completed';
      nextBatchIndex?: number | null;
    },
  ): void {
    repository.writeReviewAutofixPlan('review1', {
      schemaVersion: 1,
      snapshot: {
        severityThreshold: 'high',
        maxFindingsPerBatch: 5,
        reviewedSha: 'sha-old',
        baseBranch: 'main',
        headBranch: 'feature',
        prNumber: 7,
        snapshottedAt: '2026-09-04T00:00:00.000Z',
      },
      chainStatus: options.chainStatus,
      batches: options.batches.map((batch) => ({
        ...batch,
        findingIds: [`review1:finding:${batch.index}`],
      })),
      nextBatchIndex: options.nextBatchIndex ?? null,
      verification: { status: 'none', agentId: null },
    });
  }

  it('skips the failed batch, resumes the chain, and creates the next pending batch', async () => {
    const ctx = setup({
      findings: [resumeFinding(0), resumeFinding(1), resumeFinding(2)],
    });
    writeMultiBatchPlan(ctx.repository, {
      batches: [
        { index: 0, agentId: 'fix1', status: 'failed' },
        { index: 1, agentId: null, status: 'pending' },
        { index: 2, agentId: null, status: 'pending' },
      ],
      chainStatus: 'paused',
      nextBatchIndex: null,
    });

    const result = await ctx.service.resumeAutomaticChain('review1');

    assert.deepEqual(result, { batchIndex: 1 });
    assert.equal(ctx.calls.created.length, 1);
    const body = ctx.calls.created[0]!;
    const batchIndex = (body.autofix as { batchIndex: number }).batchIndex;
    assert.equal(batchIndex, 1);
    assert.equal((body.autofix as { findingIds: string[] }).findingIds[0], 'review1:finding:1');

    const plan = ctx.repository.readReviewAutofixPlan('review1');
    assert.equal(plan?.chainStatus, 'running');
    assert.equal(plan?.batches[0].status, 'skipped');
    assert.equal(plan?.batches[0].agentId, 'fix1');
    assert.equal(plan?.batches[1].agentId, 'fix1');
    assert.equal(plan?.batches[1].status, 'queued');
    assert.equal(plan?.nextBatchIndex, 2);
    // Failed batch findings stay manually fixable; resumed batch is assigned.
    const persisted = ctx.repository.readReviewFindings('review1');
    assert.equal(persisted?.[0].fixStatus, 'available');
    assert.equal(persisted?.[0].assignedAgentId, null);
    assert.equal(persisted?.[1].fixStatus, 'assigned');
    assert.equal(persisted?.[1].assignedAgentId, 'fix1');
  });

  it('rejects duplicate resume with a conflict while the resumed batch agent is active', async () => {
    const ctx = setup({
      findings: [resumeFinding(0), resumeFinding(1), resumeFinding(2)],
    });
    writeMultiBatchPlan(ctx.repository, {
      batches: [
        { index: 0, agentId: 'fix1', status: 'failed' },
        { index: 1, agentId: null, status: 'pending' },
      ],
      chainStatus: 'paused',
      nextBatchIndex: null,
    });

    await ctx.service.resumeAutomaticChain('review1');

    // The chain is now running with fix2 queued; a second click conflicts.
    await assert.rejects(
      () => ctx.service.resumeAutomaticChain('review1'),
      (err: unknown) => err instanceof CodedError && err.code === 'DUPLICATE',
    );
    assert.equal(ctx.calls.created.length, 1, 'no duplicate agent created');
  });

  it('rejects a second resume after the chain already advanced without an active agent', async () => {
    const ctx = setup({
      findings: [resumeFinding(0), resumeFinding(1), resumeFinding(2)],
    });
    writeMultiBatchPlan(ctx.repository, {
      batches: [
        { index: 0, agentId: 'fix1', status: 'failed' },
        { index: 1, agentId: 'fix2', status: 'completed' },
        { index: 2, agentId: null, status: 'pending' },
      ],
      chainStatus: 'running',
      nextBatchIndex: 2,
    });

    await assert.rejects(
      () => ctx.service.resumeAutomaticChain('review1'),
      (err: unknown) => err instanceof CodedError && err.code === 'VALIDATION_ERROR',
    );
    assert.deepEqual(ctx.calls.created, []);
  });

  it('rejects when no pending batches remain', async () => {
    const ctx = setup({ findings: [resumeFinding(0)] });
    writeMultiBatchPlan(ctx.repository, {
      batches: [{ index: 0, agentId: 'fix1', status: 'failed' }],
      chainStatus: 'paused',
      nextBatchIndex: null,
    });

    await assert.rejects(
      () => ctx.service.resumeAutomaticChain('review1'),
      (err: unknown) => err instanceof CodedError && err.code === 'VALIDATION_ERROR',
    );
    assert.deepEqual(ctx.calls.created, []);
  });

  it('rejects a missing plan', async () => {
    const ctx = setup({ findings: [resumeFinding(0)] });

    await assert.rejects(
      () => ctx.service.resumeAutomaticChain('review1'),
      (err: unknown) => err instanceof CodedError && err.code === 'NOT_FOUND',
    );
    assert.deepEqual(ctx.calls.created, []);
  });

  it('rejects a non-review agent', async () => {
    const ctx = setup({ findings: [resumeFinding(0)] });
    ctx.repository.save({
      ...(ctx.repository.findById('review1') as Agent),
      agentId: 'batch1',
      mode: 'batch',
      prompt: 'work',
    });

    await assert.rejects(
      () => ctx.service.resumeAutomaticChain('batch1'),
      (err: unknown) => err instanceof CodedError && err.code === 'INVALID_MODE',
    );
    assert.deepEqual(ctx.calls.created, []);
  });

  it('pauses again when creating the resumed batch agent fails', async () => {
    const ctx = setup({
      findings: [resumeFinding(0), resumeFinding(1), resumeFinding(2)],
    });
    writeMultiBatchPlan(ctx.repository, {
      batches: [
        { index: 0, agentId: 'fix1', status: 'failed' },
        { index: 1, agentId: null, status: 'pending' },
      ],
      chainStatus: 'paused',
      nextBatchIndex: null,
    });
    ctx.createAgentError = new Error('queue is full');

    // createNextAutomaticBatch swallows the creation failure: the plan was
    // already persisted as running, but the new batch fails and the chain
    // pauses again — no throw reaches the route.
    await ctx.service.resumeAutomaticChain('review1');

    const plan = ctx.repository.readReviewAutofixPlan('review1');
    assert.equal(plan?.chainStatus, 'paused');
    assert.equal(plan?.batches[0].status, 'skipped');
    assert.equal(plan?.batches[1].status, 'failed');
    // Nothing was assigned.
    const persisted = ctx.repository.readReviewFindings('review1');
    assert.equal(persisted?.[1].fixStatus, 'available');
    assert.equal(persisted?.[1].assignedAgentId, null);
  });
});

describe('handleFixAgentStarted / handleFixAgentFinished', () => {
  function automaticFinding(ordinal: number, overrides: Partial<ReviewFindingRecord> = {}): ReviewFindingRecord {
    return finding({
      id: `review1:finding:${ordinal}`,
      ordinal,
      severity: 'high',
      fixStatus: 'available',
      assignedAgentId: null,
      fixedAt: null,
      github: {
        reviewId: '1',
        commentId: 42,
        commentUrl: 'https://example.com/comment/42',
        threadId: null,
        resolutionStatus: 'pending',
        resolutionError: null,
        resolvedAt: null,
      },
      ...overrides,
    });
  }

  function writeBatchPlan(
    repository: AgentRepository,
    options: {
      batches: Array<{ index: number; findingIds: string[]; agentId: string | null; status: AutofixBatchPlan['status'] }>;
      chainStatus?: 'running' | 'paused' | 'completed';
      nextBatchIndex?: number | null;
      verificationStatus?: 'none' | 'pending';
    },
  ): void {
    repository.writeReviewAutofixPlan('review1', {
      schemaVersion: 1,
      snapshot: {
        severityThreshold: 'high',
        maxFindingsPerBatch: 5,
        reviewedSha: 'sha-old',
        baseBranch: 'main',
        headBranch: 'feature',
        prNumber: 7,
        snapshottedAt: '2026-09-04T00:00:00.000Z',
      },
      chainStatus: options.chainStatus ?? 'running',
      batches: options.batches.map((batch) => ({ ...batch })),
      nextBatchIndex: options.nextBatchIndex ?? null,
      verification: { status: options.verificationStatus ?? 'none', agentId: null },
    });
  }

  /** Creates the first batch through the service, then simulates its lifecycle. */
  async function startFirstBatch(ctx: TestContext): Promise<string> {
    await ctx.service.startAutomaticChain('review1');
    const plan = ctx.repository.readReviewAutofixPlan('review1');
    const agentId = plan?.batches[0]?.agentId;
    assert.ok(agentId, 'first batch should have an agent');
    return agentId;
  }

  function setTerminalStatus(
    repository: AgentRepository,
    fixAgentId: string,
    patch: Partial<Agent>,
  ): void {
    const agent = repository.findById(fixAgentId);
    if (!agent) {
      throw new Error(`missing fix agent ${fixAgentId}`);
    }
    repository.update(fixAgentId, patch);
  }

  it('start moves findings assigned→fixing and the batch queued→running', async () => {
    const ctx = setup({ findings: [automaticFinding(0)] });
    writeBatchPlan(ctx.repository, {
      batches: [{ index: 0, findingIds: ['review1:finding:0'], agentId: null, status: 'pending' }],
      nextBatchIndex: 0,
    });
    const fixAgentId = await startFirstBatch(ctx);

    ctx.service.handleFixAgentStarted(fixAgentId);

    const persisted = ctx.repository.readReviewFindings('review1');
    assert.equal(persisted?.[0].fixStatus, 'fixing');
    assert.equal(persisted?.[0].assignedAgentId, fixAgentId);
    const plan = ctx.repository.readReviewAutofixPlan('review1');
    assert.equal(plan?.batches[0].status, 'running');
  });

  it('successful push marks findings fixed, resolves threads, and creates the next batch', async () => {
    const ctx = setup({ findings: [automaticFinding(0), automaticFinding(1)] });
    writeBatchPlan(ctx.repository, {
      batches: [
        { index: 0, findingIds: ['review1:finding:0'], agentId: null, status: 'pending' },
        { index: 1, findingIds: ['review1:finding:1'], agentId: null, status: 'pending' },
      ],
      nextBatchIndex: 0,
    });
    ctx.lookupResult = { threadId: 'thread-1', isResolved: false };
    const firstFixAgentId = await startFirstBatch(ctx);
    ctx.service.handleFixAgentStarted(firstFixAgentId);

    setTerminalStatus(ctx.repository, firstFixAgentId, { status: 'completed', pushed: true });
    await ctx.service.handleFixAgentFinished(firstFixAgentId);

    const persisted = ctx.repository.readReviewFindings('review1');
    const first = persisted?.find((entry) => entry.id === 'review1:finding:0');
    const second = persisted?.find((entry) => entry.id === 'review1:finding:1');
    assert.equal(first?.fixStatus, 'fixed');
    assert.ok(first?.fixedAt);
    assert.equal(first?.github.resolutionStatus, 'resolved');
    assert.equal(first?.github.threadId, 'thread-1');
    assert.equal(second?.fixStatus, 'assigned');
    assert.equal(second?.assignedAgentId, 'fix2');

    const plan = ctx.repository.readReviewAutofixPlan('review1');
    assert.equal(plan?.chainStatus, 'running');
    assert.equal(plan?.batches[0].status, 'completed');
    assert.equal(plan?.batches[1].agentId, 'fix2');
    assert.equal(plan?.batches[1].status, 'queued');
    assert.equal(plan?.nextBatchIndex, null);
    assert.equal(ctx.calls.created.length, 2);
  });

  it('final successful batch completes the chain and marks verification pending', async () => {
    const ctx = setup({ findings: [automaticFinding(0), automaticFinding(1)] });
    writeBatchPlan(ctx.repository, {
      batches: [
        { index: 0, findingIds: ['review1:finding:0'], agentId: null, status: 'pending' },
        { index: 1, findingIds: ['review1:finding:1'], agentId: null, status: 'pending' },
      ],
      nextBatchIndex: 0,
    });
    const firstFixAgentId = await startFirstBatch(ctx);
    ctx.service.handleFixAgentStarted(firstFixAgentId);
    setTerminalStatus(ctx.repository, firstFixAgentId, { status: 'completed', pushed: true });
    await ctx.service.handleFixAgentFinished(firstFixAgentId);

    const secondFixAgentId = 'fix2';
    ctx.service.handleFixAgentStarted(secondFixAgentId);
    setTerminalStatus(ctx.repository, secondFixAgentId, { status: 'completed', pushed: true });
    await ctx.service.handleFixAgentFinished(secondFixAgentId);

    const plan = ctx.repository.readReviewAutofixPlan('review1');
    assert.equal(plan?.chainStatus, 'completed');
    assert.equal(plan?.nextBatchIndex, null);
    assert.equal(plan?.batches[1].status, 'completed');
    // The completion path schedules the verification review in the same step;
    // exactly one review agent is created across both batches.
    assert.deepEqual(plan?.verification, { status: 'queued', agentId: 'verify1' });
    const verificationReviews = ctx.calls.created.filter((entry) => entry.__kind === 'review');
    assert.equal(verificationReviews.length, 1);
    assert.equal(ctx.calls.created.length, 3);
  });

  it('a failed batch marks findings failed, pauses the chain, and creates no later batch', async () => {
    const ctx = setup({ findings: [automaticFinding(0), automaticFinding(1)] });
    writeBatchPlan(ctx.repository, {
      batches: [
        { index: 0, findingIds: ['review1:finding:0'], agentId: null, status: 'pending' },
        { index: 1, findingIds: ['review1:finding:1'], agentId: null, status: 'pending' },
      ],
      nextBatchIndex: 0,
    });
    const firstFixAgentId = await startFirstBatch(ctx);
    ctx.service.handleFixAgentStarted(firstFixAgentId);

    setTerminalStatus(ctx.repository, firstFixAgentId, { status: 'failed', pushed: false });
    await ctx.service.handleFixAgentFinished(firstFixAgentId);

    const persisted = ctx.repository.readReviewFindings('review1');
    assert.equal(persisted?.[0].fixStatus, 'failed');
    assert.equal(persisted?.[1].fixStatus, 'available');
    const plan = ctx.repository.readReviewAutofixPlan('review1');
    assert.equal(plan?.chainStatus, 'paused');
    assert.equal(plan?.batches[0].status, 'failed');
    assert.equal(plan?.batches[1].status, 'pending');
    assert.equal(plan?.nextBatchIndex, null);
    assert.equal(ctx.calls.created.length, 1);
  });

  it('completed without a push pauses the chain like a failure', async () => {
    const ctx = setup({ findings: [automaticFinding(0)] });
    writeBatchPlan(ctx.repository, {
      batches: [{ index: 0, findingIds: ['review1:finding:0'], agentId: null, status: 'pending' }],
      nextBatchIndex: 0,
    });
    const fixAgentId = await startFirstBatch(ctx);
    ctx.service.handleFixAgentStarted(fixAgentId);

    setTerminalStatus(ctx.repository, fixAgentId, { status: 'completed', pushed: false });
    await ctx.service.handleFixAgentFinished(fixAgentId);

    const persisted = ctx.repository.readReviewFindings('review1');
    assert.equal(persisted?.[0].fixStatus, 'failed');
    const plan = ctx.repository.readReviewAutofixPlan('review1');
    assert.equal(plan?.chainStatus, 'paused');
    assert.equal(plan?.batches[0].status, 'failed');
    assert.deepEqual(plan?.verification, { status: 'none', agentId: null });
  });

  it('resolution failure never changes the coding outcome', async () => {
    const ctx = setup({ findings: [automaticFinding(0)] });
    writeBatchPlan(ctx.repository, {
      batches: [{ index: 0, findingIds: ['review1:finding:0'], agentId: null, status: 'pending' }],
      nextBatchIndex: null,
    });
    ctx.lookupResult = null;
    const fixAgentId = await startFirstBatch(ctx);
    ctx.service.handleFixAgentStarted(fixAgentId);

    setTerminalStatus(ctx.repository, fixAgentId, { status: 'completed', pushed: true });
    await ctx.service.handleFixAgentFinished(fixAgentId);

    const persisted = ctx.repository.readReviewFindings('review1');
    assert.equal(persisted?.[0].fixStatus, 'fixed');
    assert.equal(persisted?.[0].github.resolutionStatus, 'failed');
    assert.match(persisted?.[0].github.resolutionError ?? '', /thread lookup failed/);
    const plan = ctx.repository.readReviewAutofixPlan('review1');
    assert.equal(plan?.batches[0].status, 'completed');
  });

  it('a manual fix agent finishing without a push re-enables the finding without touching the plan', async () => {
    const ctx = setup({ findings: [automaticFinding(0)] });
    ctx.branches = ['feature'];
    const result = await ctx.service.createManualFix('review1', 'review1:finding:0');
    ctx.service.handleFixAgentStarted(result.agent.agentId);

    const persistedAfterStart = ctx.repository.readReviewFindings('review1');
    assert.equal(persistedAfterStart?.[0].fixStatus, 'fixing');

    setTerminalStatus(ctx.repository, result.agent.agentId, { status: 'completed', pushed: false });
    await ctx.service.handleFixAgentFinished(result.agent.agentId);

    const persisted = ctx.repository.readReviewFindings('review1');
    assert.equal(persisted?.[0].fixStatus, 'failed');
    // No plan exists in this test — the hook must not throw or create agents.
    assert.equal(ctx.calls.created.length, 1);
  });

  it('resolution succeeds through the cached flow for a successful manual fix', async () => {
    const ctx = setup({ findings: [automaticFinding(0)] });
    ctx.branches = ['feature'];
    ctx.lookupResult = { threadId: 'thread-1', isResolved: false };
    const result = await ctx.service.createManualFix('review1', 'review1:finding:0');
    ctx.service.handleFixAgentStarted(result.agent.agentId);

    setTerminalStatus(ctx.repository, result.agent.agentId, { status: 'completed', pushed: true });
    await ctx.service.handleFixAgentFinished(result.agent.agentId);

    const persisted = ctx.repository.readReviewFindings('review1');
    assert.equal(persisted?.[0].fixStatus, 'fixed');
    assert.equal(persisted?.[0].github.resolutionStatus, 'resolved');
    assert.deepEqual(ctx.calls.resolved, ['thread-1']);
  });

  it('is a no-op for agents without autofix metadata', async () => {
    const ctx = setup({ findings: [automaticFinding(0)] });
    const unrelated = {
      ...(ctx.repository.findById('review1') as Agent),
      agentId: 'plain1',
      mode: 'batch' as const,
      prompt: 'work',
    };
    ctx.repository.save(unrelated);

    ctx.service.handleFixAgentStarted('plain1');
    await ctx.service.handleFixAgentFinished('plain1');

    assert.deepEqual(ctx.calls.created, []);
    const persisted = ctx.repository.readReviewFindings('review1');
    assert.equal(persisted?.[0].fixStatus, 'available');
  });

  it('is a no-op when the fix agent is missing', async () => {
    const ctx = setup({ findings: [automaticFinding(0)] });
    ctx.service.handleFixAgentStarted('missing');
    await ctx.service.handleFixAgentFinished('missing');
    assert.deepEqual(ctx.calls.created, []);
  });
});
describe('scheduleVerificationReview', () => {
  function drainFinding(ordinal: number, overrides: Partial<ReviewFindingRecord> = {}): ReviewFindingRecord {
    return finding({
      id: `review1:finding:${ordinal}`,
      ordinal,
      severity: 'high',
      fixStatus: 'fixed',
      assignedAgentId: 'fix1',
      fixedAt: '2026-09-04T00:00:00.000Z',
      ...overrides,
    });
  }

  it('creates one verification review and persists it into the plan', async () => {
    const ctx = setup({ findings: [drainFinding(0)] });

    const agentId = await ctx.service.scheduleVerificationReview('review1', 'automatic');

    assert.equal(agentId, 'verify1');
    assert.equal(ctx.calls.created.length, 1);
    const body = ctx.calls.created[0]!;
    assert.equal(body.__kind, 'review');
    assert.equal(body.repoId, 'r1');
    assert.equal(body.mode, 'review');
    assert.equal(body.headBranch, 'feature');
    assert.equal(body.background, 'autofix-verification:review1');

    const created = ctx.repository.findById('verify1') as Agent;
    assert.equal(created.review?.purpose, 'verification');
    assert.equal(created.review?.autofixIneligible, true);
    assert.equal(created.review?.sourceReviewAgentId, 'review1');

    // No plan in this test — dedup falls back to the agent scan.
    const duplicate = await ctx.service.scheduleVerificationReview('review1', 'automatic');
    assert.equal(duplicate, 'verify1');
    assert.equal(ctx.calls.created.length, 1, 'no duplicate review agent created');
  });

  it('returns the existing verification agent recorded in the plan without creating another', async () => {
    const ctx = setup({ findings: [drainFinding(0)] });
    ctx.repository.writeReviewAutofixPlan('review1', {
      schemaVersion: 1,
      snapshot: {
        severityThreshold: 'high',
        maxFindingsPerBatch: 5,
        reviewedSha: 'sha-old',
        baseBranch: 'main',
        headBranch: 'feature',
        prNumber: 7,
        snapshottedAt: '2026-09-04T00:00:00.000Z',
      },
      chainStatus: 'completed',
      batches: [],
      nextBatchIndex: null,
      verification: { status: 'queued', agentId: 'verify-existing' },
    });

    const agentId = await ctx.service.scheduleVerificationReview('review1', 'automatic');

    assert.equal(agentId, 'verify-existing');
    assert.deepEqual(ctx.calls.created, []);
  });

  it('rejects scheduling while a related fix agent is queued or running (drain guard)', async () => {
    const ctx = setup({ findings: [drainFinding(0)] });
    const activeFix = {
      ...(ctx.repository.findById('review1') as Agent),
      agentId: 'fix-active',
      mode: 'batch' as const,
      prompt: 'work',
      status: 'running' as const,
      autofix: { kind: 'manual' as const, sourceReviewAgentId: 'review1', findingIds: ['review1:finding:0'] },
    };
    ctx.repository.save(activeFix);

    const agentId = await ctx.service.scheduleVerificationReview('review1', 'manual');

    assert.equal(agentId, null);
    assert.deepEqual(ctx.calls.created, []);
  });

  it('is a no-op when the review-agent factory is not available', async () => {
    const ctx = setup({ findings: [drainFinding(0)] });
    ctx.reviewAgentFactoryMissing = true;
    // Recreate the service without the review factory.
    ctx.service = createReviewAutofixService({
      repository: ctx.repository,
      repoManager: { getRepo: () => ({ owner: 'acme', name: 'demo' }) } as unknown as RepoService,
      configRepository: { load: () => ({}) } as unknown as ConfigRepository,
      githubApp: {} as unknown as GithubAppService,
      createBatchAgent: () => {
        throw new Error('not used');
      },
    });

    const agentId = await ctx.service.scheduleVerificationReview('review1', 'automatic');

    assert.equal(agentId, null);
  });

  it('is a no-op when agent creation throws', async () => {
    const ctx = setup({ findings: [drainFinding(0)] });
    ctx.createReviewAgentError = new Error('review queue is full');

    const agentId = await ctx.service.scheduleVerificationReview('review1', 'automatic');

    assert.equal(agentId, null);
  });

  it('is a no-op for a missing or non-review agent', async () => {
    const ctx = setup({ findings: [drainFinding(0)] });
    assert.equal(await ctx.service.scheduleVerificationReview('missing', 'manual'), null);

    ctx.repository.save({
      ...(ctx.repository.findById('review1') as Agent),
      agentId: 'batch1',
      mode: 'batch',
      prompt: 'work',
    });
    assert.equal(await ctx.service.scheduleVerificationReview('batch1', 'manual'), null);
  });

  it('final automatic batch schedules the verification review with metadata and plan dedup', async () => {
    const ctx = setup({ findings: [drainFinding(0)] });
    ctx.repository.writeReviewAutofixPlan('review1', {
      schemaVersion: 1,
      snapshot: {
        severityThreshold: 'high',
        maxFindingsPerBatch: 5,
        reviewedSha: 'sha-old',
        baseBranch: 'main',
        headBranch: 'feature',
        prNumber: 7,
        snapshottedAt: '2026-09-04T00:00:00.000Z',
      },
      chainStatus: 'running',
      batches: [{ index: 0, findingIds: ['review1:finding:0'], agentId: null, status: 'pending' }],
      nextBatchIndex: 0,
      verification: { status: 'none', agentId: null },
    });
    const fixAgentId = 'manual-fix-1';
    // Simulate the terminal fix agent that the plan tracks.
    ctx.repository.save({
      ...(ctx.repository.findById('review1') as Agent),
      agentId: fixAgentId,
      mode: 'batch' as const,
      prompt: 'work',
      status: 'completed' as const,
      pushed: true,
      autofix: { kind: 'automatic' as const, sourceReviewAgentId: 'review1', findingIds: ['review1:finding:0'], batchIndex: 0 },
    });
    ctx.repository.update(fixAgentId, { status: 'completed', pushed: true });
    // Mark the batch queued under the fix agent, then finish it successfully.
    ctx.repository.writeReviewAutofixPlan('review1', {
      schemaVersion: 1,
      snapshot: {
        severityThreshold: 'high',
        maxFindingsPerBatch: 5,
        reviewedSha: 'sha-old',
        baseBranch: 'main',
        headBranch: 'feature',
        prNumber: 7,
        snapshottedAt: '2026-09-04T00:00:00.000Z',
      },
      chainStatus: 'running',
      batches: [{ index: 0, findingIds: ['review1:finding:0'], agentId: fixAgentId, status: 'running' }],
      nextBatchIndex: null,
      verification: { status: 'none', agentId: null },
    });

    await ctx.service.handleFixAgentFinished(fixAgentId);

    const plan = ctx.repository.readReviewAutofixPlan('review1');
    assert.equal(plan?.chainStatus, 'completed');
    assert.equal(plan?.verification.agentId, 'verify1');
    assert.equal(plan?.verification.status, 'queued');
    const created = ctx.repository.findById('verify1') as Agent | undefined;
    assert.equal(created?.review?.autofixIneligible, true);
  });

  it('manual fix drain coalesces into one verification review', async () => {
    const ctx = setup({ findings: [drainFinding(0)] });
    ctx.branches = ['feature'];
    // Two manual fix agents on the same source review.
    const first = {
      ...(ctx.repository.findById('review1') as Agent),
      agentId: 'manual1',
      mode: 'batch' as const,
      prompt: 'fix a',
      status: 'completed' as const,
      pushed: true,
      autofix: { kind: 'manual' as const, sourceReviewAgentId: 'review1', findingIds: ['review1:finding:0'] },
    };
    const second = {
      ...first,
      agentId: 'manual2',
      status: 'queued' as const,
      pushed: false,
    };
    ctx.repository.save(first);
    ctx.repository.save(second);

    // First finishes while the sibling is still queued — drain guard holds.
    await ctx.service.handleFixAgentFinished('manual1');
    assert.deepEqual(ctx.calls.created, [], 'no verification while a sibling fix agent is active');

    // Sibling finishes — work has drained, verification is created once.
    ctx.repository.update('manual2', { status: 'completed', pushed: true });
    await ctx.service.handleFixAgentFinished('manual2');

    const reviews = (ctx.calls.created as Array<Record<string, unknown>>).filter(
      (entry) => entry.__kind === 'review',
    );
    assert.equal(reviews.length, 1);
    const created = ctx.repository.findById('verify1') as Agent | undefined;
    assert.equal(created?.review?.sourceReviewAgentId, 'review1');
  });
});

describe('reconcileAutofixPlansOnStartup', () => {
  function reconcileFinding(
    ordinal: number,
    fixStatus: ReviewFindingRecord['fixStatus'],
    assignedAgentId: string | null,
  ): ReviewFindingRecord {
    return finding({
      id: `review1:finding:${ordinal}`,
      ordinal,
      severity: 'high',
      fixStatus,
      assignedAgentId,
      fixedAt: null,
      github: {
        reviewId: '1',
        commentId: null,
        commentUrl: null,
        threadId: null,
        resolutionStatus: 'not_applicable',
        resolutionError: null,
        resolvedAt: null,
      },
    });
  }

  function writePlan(
    repository: AgentRepository,
    options: {
      batches: Array<{ index: number; agentId: string | null; status: AutofixBatchPlan['status'] }>;
      chainStatus: 'running' | 'paused';
      nextBatchIndex?: number | null;
    },
  ): void {
    repository.writeReviewAutofixPlan('review1', {
      schemaVersion: 1,
      snapshot: {
        severityThreshold: 'high',
        maxFindingsPerBatch: 5,
        reviewedSha: 'sha-old',
        baseBranch: 'main',
        headBranch: 'feature',
        prNumber: 7,
        snapshottedAt: '2026-09-04T00:00:00.000Z',
      },
      chainStatus: options.chainStatus,
      batches: options.batches.map((batch) => ({
        ...batch,
        findingIds: [`review1:finding:${batch.index}`],
      })),
      nextBatchIndex: options.nextBatchIndex ?? null,
      verification: { status: 'none', agentId: null },
    });
  }

  function seedFixAgent(
    ctx: TestContext,
    agentId: string,
    status: Agent['status'],
    findingIds: string[],
    batchIndex?: number,
  ): void {
    ctx.repository.save({
      ...(ctx.repository.findById('review1') as Agent),
      agentId,
      mode: 'batch',
      prompt: 'fix findings',
      status,
      pushed: false,
      autofix: {
        kind: batchIndex === undefined ? ('manual' as const) : ('automatic' as const),
        sourceReviewAgentId: 'review1',
        findingIds,
        ...(batchIndex === undefined ? {} : { batchIndex }),
      },
    } as Agent);
  }

  it('retains a queued fix agent and keeps the chain running for re-enqueue', () => {
    const ctx = setup({ findings: [reconcileFinding(0, 'assigned', 'fix1')] });
    writePlan(ctx.repository, {
      batches: [{ index: 0, agentId: 'fix1', status: 'queued' }],
      chainStatus: 'running',
      nextBatchIndex: null,
    });
    seedFixAgent(ctx, 'fix1', 'queued', ['review1:finding:0'], 0);

    ctx.service.reconcileAutofixPlansOnStartup();

    const plan = ctx.repository.readReviewAutofixPlan('review1');
    assert.equal(plan?.chainStatus, 'running');
    assert.equal(plan?.batches[0].status, 'queued');
    assert.equal(plan?.batches[0].agentId, 'fix1');
    const persisted = ctx.repository.readReviewFindings('review1');
    assert.equal(persisted?.[0].fixStatus, 'assigned');
    assert.equal(ctx.calls.created.length, 0, 'no agents created during reconciliation');
  });

  it('marks a queued batch failed and pauses when the agent record is missing', () => {
    const ctx = setup({ findings: [reconcileFinding(0, 'assigned', 'fix-ghost')] });
    writePlan(ctx.repository, {
      batches: [{ index: 0, agentId: 'fix-ghost', status: 'queued' }],
      chainStatus: 'running',
      nextBatchIndex: null,
    });

    ctx.service.reconcileAutofixPlansOnStartup();

    const plan = ctx.repository.readReviewAutofixPlan('review1');
    assert.equal(plan?.chainStatus, 'paused');
    assert.equal(plan?.batches[0].status, 'failed');
    assert.equal(plan?.nextBatchIndex, null);
    const persisted = ctx.repository.readReviewFindings('review1');
    assert.equal(persisted?.[0].fixStatus, 'failed', 'assigned finding becomes failed/actionable');
    assert.equal(ctx.calls.created.length, 0);
  });

  it('derives completed for a running batch whose agent completed with a push', () => {
    const ctx = setup({ findings: [reconcileFinding(0, 'fixing', 'fix1')] });
    writePlan(ctx.repository, {
      batches: [{ index: 0, agentId: 'fix1', status: 'running' }],
      chainStatus: 'running',
      nextBatchIndex: null,
    });
    seedFixAgent(ctx, 'fix1', 'completed', ['review1:finding:0'], 0);
    ctx.repository.update('fix1', { status: 'completed', pushed: true });

    ctx.service.reconcileAutofixPlansOnStartup();

    const plan = ctx.repository.readReviewAutofixPlan('review1');
    assert.equal(plan?.batches[0].status, 'completed');
    assert.equal(plan?.chainStatus, 'paused', 'no batch is created automatically after restart');
    const persisted = ctx.repository.readReviewFindings('review1');
    assert.equal(persisted?.[0].fixStatus, 'fixed');
    assert.ok(persisted?.[0].fixedAt);
  });

  it('derives failed for a running batch whose agent completed without a push', () => {
    const ctx = setup({ findings: [reconcileFinding(0, 'fixing', 'fix1')] });
    writePlan(ctx.repository, {
      batches: [{ index: 0, agentId: 'fix1', status: 'running' }],
      chainStatus: 'running',
      nextBatchIndex: null,
    });
    seedFixAgent(ctx, 'fix1', 'completed', ['review1:finding:0'], 0);
    ctx.repository.update('fix1', { status: 'completed', pushed: false });

    ctx.service.reconcileAutofixPlansOnStartup();

    const plan = ctx.repository.readReviewAutofixPlan('review1');
    assert.equal(plan?.batches[0].status, 'failed');
    assert.equal(plan?.chainStatus, 'paused');
    const persisted = ctx.repository.readReviewFindings('review1');
    assert.equal(persisted?.[0].fixStatus, 'failed');
  });

  it('pauses a running chain with no active batch and nothing to create', () => {
    const ctx = setup({ findings: [reconcileFinding(0, 'fixed', 'fix1')] });
    writePlan(ctx.repository, {
      batches: [{ index: 0, agentId: 'fix1', status: 'completed' }],
      chainStatus: 'running',
      nextBatchIndex: null,
    });

    ctx.service.reconcileAutofixPlansOnStartup();

    const plan = ctx.repository.readReviewAutofixPlan('review1');
    assert.equal(plan?.chainStatus, 'paused');
  });

  it('is a no-op for paused chains, missing plans, and completed chains', () => {
    const ctx = setup({ findings: [reconcileFinding(0, 'fixed', 'fix1')] });
    writePlan(ctx.repository, {
      batches: [{ index: 0, agentId: 'fix1', status: 'completed' }],
      chainStatus: 'paused',
      nextBatchIndex: null,
    });

    // Paused plan: untouched.
    ctx.service.reconcileAutofixPlansOnStartup();
    let plan = ctx.repository.readReviewAutofixPlan('review1');
    assert.equal(plan?.chainStatus, 'paused');
    assert.equal(plan?.batches[0].status, 'completed');

    // Missing plan: no throw, no writes.
    ctx.repository.save({
      ...(ctx.repository.findById('review1') as Agent),
      agentId: 'review2',
      mode: 'review' as const,
      review: { baseBranch: 'main', headBranch: 'feat2', prNumber: null, headSha: null },
    });
    ctx.service.reconcileAutofixPlansOnStartup();
    assert.equal(ctx.repository.readReviewAutofixPlan('review2'), null);

    // Completed plan: untouched.
    ctx.repository.writeReviewAutofixPlan('review2', {
      schemaVersion: 1,
      snapshot: {
        severityThreshold: 'high',
        maxFindingsPerBatch: 5,
        reviewedSha: 'sha-old',
        baseBranch: 'main',
        headBranch: 'feat2',
        prNumber: null,
        snapshottedAt: '2026-09-04T00:00:00.000Z',
      },
      chainStatus: 'completed',
      batches: [],
      nextBatchIndex: null,
      verification: { status: 'completed', agentId: 'verify1' },
    });
    ctx.service.reconcileAutofixPlansOnStartup();
    plan = ctx.repository.readReviewAutofixPlan('review2');
    assert.equal(plan?.chainStatus, 'completed');
    assert.equal(ctx.calls.created.length, 0);
  });

  it('does not create agents for a plan with all batches terminal', () => {
    const ctx = setup({ findings: [reconcileFinding(0, 'fixed', 'fix1')] });
    writePlan(ctx.repository, {
      batches: [
        { index: 0, agentId: 'fix1', status: 'completed' },
        { index: 1, agentId: 'fix2', status: 'failed' },
      ],
      chainStatus: 'paused',
      nextBatchIndex: null,
    });

    ctx.service.reconcileAutofixPlansOnStartup();

    assert.equal(ctx.calls.created.length, 0);
    const plan = ctx.repository.readReviewAutofixPlan('review1');
    assert.equal(plan?.batches[0].status, 'completed');
    assert.equal(plan?.batches[1].status, 'failed');
  });
});
