import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createJsonStore } from '../../lib/json-store';
import type { Agent, ReviewFindingRecord } from '../../types';
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
      return {
        agentId: 'fix1',
        workspaceId: 'ws-fix1',
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
    },
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