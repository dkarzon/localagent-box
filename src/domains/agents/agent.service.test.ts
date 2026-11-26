import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import { createJsonStore } from '../../lib/json-store';
import { getLogger } from '../../lib/logger';
import {
  CodedError,
  type Agent,
  type AgentReviewMetadata,
  type Repo,
} from '../../types';
import type { GithubAppService } from '../../services/github-app';
import type { GitService } from '../../services/git-service';
import type { OllamaChatService } from '../../services/ollama-client';
import type { WebhookSender } from '../../lib/webhook';
import { createConfigRepository } from '../config/config.repository';
import type { RepoService } from '../repos/repo.service';
import { createAgentRepository } from './agent.repository';
import { createAgentService } from './agent.service';

const testRepo: Repo = {
  repoId: 'acme-demo',
  owner: 'acme',
  name: 'demo',
  defaultBranch: 'main',
  cloneUrl: 'https://github.com/acme/demo.git',
  registeredAt: '2026-01-01T00:00:00.000Z',
  lastVerifiedAt: null,
  lastVerifyStatus: null,
  lastVerifyMessage: null,
  autoReviewPullRequests: null,
};

function mockChildProcess(): ChildProcess & {
  emitExit: (code?: number | null, signal?: NodeJS.Signals | null) => void;
} {
  const exitHandlers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const child: Record<string, unknown> = {
    killed: false,
    stdout: { on: () => child },
    stderr: { on: () => child },
    on: (event: string, handler: (code: number | null, signal: NodeJS.Signals | null) => void) => {
      if (event === 'exit') {
        exitHandlers.push(handler);
      }
      return child;
    },
    kill: () => {
      child.killed = true;
      return true;
    },
    emitExit: (code: number | null = 0, signal: NodeJS.Signals | null = null) => {
      for (const handler of exitHandlers) {
        handler(code, signal);
      }
    },
  };
  return child as unknown as ChildProcess & {
    emitExit: (code?: number | null, signal?: NodeJS.Signals | null) => void;
  };
}

function baseAgentFields(overrides: Partial<Agent> & Pick<Agent, 'agentId' | 'mode' | 'status'>): Agent {
  return {
    workspaceId: 'ws-test',
    repoId: testRepo.repoId,
    prompt: 'Refactor auth',
    systemPrompt: null,
    baseBranch: 'main',
    agentBranch: 'localagent-test',
    commitMessage: 'Agent: test',
    push: true,
    pushOnFailure: false,
    model: null,
    commitSha: null,
    pushed: false,
    filesChanged: null,
    createdAt: '2026-06-09T00:00:00.000Z',
    startedAt: '2026-06-09T00:00:01.000Z',
    finishedAt: null,
    branch: null,
    error: null,
    result: null,
    pullRequest: null,
    ...overrides,
  };
}

interface TestContext {
  root: string;
  dataDir: string;
  workspaceRoot: string;
  service: ReturnType<typeof createAgentService>;
  repository: ReturnType<typeof createAgentRepository>;
  configRepository: ReturnType<typeof createConfigRepository>;
  spawned: Array<ReturnType<typeof mockChildProcess>>;
}

const contexts: TestContext[] = [];

function createTestContext(options?: {
  onCreatePullRequest?: () => void;
  ollamaChat?: OllamaChatService;
  capturePullRequest?: (input: { title: string; body: string }) => void;
  webhookSender?: WebhookSender;
  repoOverride?: Partial<Repo>;
  /** Mutable flag: when `fail` is true, repo lookups throw (e.g. repo deleted mid-run). */
  repoLookup?: { fail: boolean };
  maxConcurrent?: number;
}): TestContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-service-'));
  const dataDir = path.join(root, 'data');
  const workspaceRoot = path.join(root, 'workspaces');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });

  const agentsStore = createJsonStore<{ agents: Agent[] }>(
    path.join(dataDir, 'agents.json'),
    { agents: [] },
    fs,
  );
  const configRepository = createConfigRepository(dataDir, fs);
  configRepository.save({
    githubAppId: '123',
    githubAppInstallationId: '456',
    githubAppPrivateKey: 'test-key',
    ollamaBaseUrl: options?.ollamaChat ? 'http://localhost:11434' : undefined,
    opencodeModel: options?.ollamaChat ? 'qwen2.5-coder:7b' : undefined,
  });

  const repository = createAgentRepository({
    dataDir,
    workspaceRoot,
    agentsStore,
    fs,
    path,
  });

  const repoEntry: Repo = { ...testRepo, ...options?.repoOverride };

  const repoManager = {
    getRepo: (repoId: string) => {
      if (repoId !== testRepo.repoId || options?.repoLookup?.fail) {
        throw new Error(`Unknown repo: ${repoId}`);
      }
      return repoEntry;
    },
  } as RepoService;

  const githubApp: GithubAppService = {
    assertConfigured: () => {},
    getCredentialSummary: () => ({
      configured: false,
      githubAppId: '',
      githubAppInstallationId: '',
      hasPrivateKey: false,
      gitUserConfigured: false,
    }),
    getInstallationToken: async () => 'test-token',
    buildAuthenticatedCloneUrl: () => '',
    createPullRequest: async (_config, input) => {
      options?.onCreatePullRequest?.();
      options?.capturePullRequest?.({ title: input.title, body: input.body ?? '' });
      return {
        number: 42,
        title: input.title,
        html_url: 'https://github.com/acme/demo/pull/42',
        state: 'open',
        created_at: '2026-06-09T00:10:00.000Z',
        merged_at: null,
        updated_at: '2026-06-09T00:10:00.000Z',
        head: { sha: 'deadbeef1234567890abcdef1234567890abcdef', ref: input.head },
      };
    },
    fetchRepositoryBranches: async () => [],
    getPullRequest: async () => {
      throw new Error('not implemented');
    },
    findPullRequestByHead: async () => null,
    createCheckRun: async () => {
      throw new Error('not implemented');
    },
    updateCheckRun: async (_config, _owner, _repoName, checkRunId) => ({
      id: checkRunId,
      html_url: 'https://example.com/check/1',
      status: 'completed',
      conclusion: null,
    }),
    createPullRequestReview: async () => ({ id: '1', html_url: 'https://example.com/review/1' }),
    createPullRequestReviewComment: async () => ({ id: '2', html_url: 'https://example.com/review/comment/2' }),
    upsertStickyIssueComment: async () => ({ id: 3, html_url: 'https://example.com/comment/3', created: true }),
    listPullRequestReviewComments: async () => [],
    findReviewThreadIdForComment: async () => null,
    findReviewThreadForLocation: async () => null,
    resolvePullRequestReviewThread: async (_config, threadId) => ({
      threadId,
      isResolved: true,
    }),
    redactSecrets: (text) => text,
    createAppJwt: () => '',
    normalizePrivateKey: (key) => key,
    resolveBotGitIdentity: async () => ({
      gitUserName: 'test[bot]',
      gitUserEmail: '1+test[bot]@users.noreply.github.com',
    }),
  };

  const gitService: GitService = {
    applyGitConfig: () => {},
    shallowClone: async () => {},
    verifyClone: async () => ({
      ok: true,
      owner: testRepo.owner,
      name: testRepo.name,
      branch: testRepo.defaultBranch,
      message: 'ok',
    }),
    createBranch: async () => {},
    fetchAndCheckoutBranch: async () => {},
    remoteBranchExists: async () => false,
    ensureRemoteRef: async () => ({ available: true, fetched: false }),
    getPorcelainStatus: async () => ' M src/changed.ts',
    getDiffStat: async () => ' src/changed.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)',
    parsePorcelainStatus: () => [{ path: 'src/changed.ts', kind: 'modified', statusCode: ' M' }],
    countChangedFiles: () => 1,
    commitAll: async () => 'deadbeef1234567890',
    pushBranch: async () => {},
    getCommitDiff: async () => null,
    markRunStart: async () => {},
    getHeadSha: async () => 'deadbeef1234567890',
    getCommitsSinceRunStart: async () => ({ commits: 0, filesChanged: 0 }),
  };

  const spawned: Array<ReturnType<typeof mockChildProcess>> = [];
  const service = createAgentService({
    dataDir,
    workspaceRoot,
    agentsStore,
    repoManager,
    configRepository,
    githubApp,
    gitService,
    ollamaChat: options?.ollamaChat,
    webhookSender: options?.webhookSender,
    repository,
    spawn: () => {
      const child = mockChildProcess();
      spawned.push(child);
      return child;
    },
    maxConcurrent: options?.maxConcurrent ?? 1,
  });

  const ctx = { root, dataDir, workspaceRoot, service, repository, configRepository, spawned };
  contexts.push(ctx);
  return ctx;
}

function hasStartedWorker(ctx: TestContext, agentId: string): boolean {
  return fs.existsSync(path.join(ctx.repository.getAgentDir(agentId), 'job.json'));
}

function seedAgent(repository: TestContext['repository'], agent: Agent): void {
  fs.mkdirSync(repository.getAgentDir(agent.agentId), { recursive: true });
  fs.writeFileSync(repository.getLogPath(agent.agentId), '', 'utf8');
  repository.save(agent);
}

afterEach(() => {
  while (contexts.length > 0) {
    const ctx = contexts.pop()!;
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});

describe('createAgentService', () => {
  it('persists autofix metadata on batch agents', () => {
    const { service, repository } = createTestContext();

    const agent = service.createAgent({
      repoId: testRepo.repoId,
      prompt: 'Fix finding',
      mode: 'batch',
      useExistingBranch: true,
      baseBranch: 'feature/fix',
      autofix: {
        kind: 'automatic',
        sourceReviewAgentId: 'review1',
        findingIds: ['f1', 'f2'],
        batchIndex: 0,
      },
    } as unknown as Parameters<ReturnType<typeof createAgentService>['createAgent']>[0]);

    assert.deepEqual(agent.autofix, {
      kind: 'automatic',
      sourceReviewAgentId: 'review1',
      findingIds: ['f1', 'f2'],
      batchIndex: 0,
    });
    assert.deepEqual(repository.findById(agent.agentId)?.autofix, {
      kind: 'automatic',
      sourceReviewAgentId: 'review1',
      findingIds: ['f1', 'f2'],
      batchIndex: 0,
    });
  });
});

describe('cancelAgent', () => {
  it('cancels an active batch agent without committing', () => {
    const { service, repository } = createTestContext();
    const agentId = 'batchcancel01';
    seedAgent(
      repository,
      baseAgentFields({
        agentId,
        mode: 'batch',
        status: 'processing',
      }),
    );

    const updated = service.cancelAgent(agentId);

    assert.equal(updated.status, 'cancelled');
    assert.equal(updated.error, 'Cancelled by user');
    assert.ok(updated.finishedAt);
  });
});

describe('cleanupOldWorkspaces', () => {
  function daysAgo(days: number): string {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  }

  it('deletes terminal sessions older than the retention window', () => {
    const { service, repository, workspaceRoot } = createTestContext();
    const oldAgentId = 'oldsession01';
    const recentAgentId = 'newsession01';
    const oldWorkspaceId = 'ws-old-001';
    const recentWorkspaceId = 'ws-new-001';

    seedAgent(
      repository,
      baseAgentFields({
        agentId: oldAgentId,
        workspaceId: oldWorkspaceId,
        mode: 'batch',
        status: 'completed',
        finishedAt: daysAgo(45),
      }),
    );
    seedAgent(
      repository,
      baseAgentFields({
        agentId: recentAgentId,
        workspaceId: recentWorkspaceId,
        mode: 'batch',
        status: 'completed',
        finishedAt: daysAgo(5),
      }),
    );

    fs.mkdirSync(repository.getWorkspaceDir(oldWorkspaceId), { recursive: true });
    fs.mkdirSync(repository.getWorkspaceDir(recentWorkspaceId), { recursive: true });
    fs.writeFileSync(path.join(repository.getWorkspaceDir(oldWorkspaceId), 'marker.txt'), 'old');
    fs.writeFileSync(
      path.join(repository.getWorkspaceDir(recentWorkspaceId), 'marker.txt'),
      'new',
    );

    const result = service.cleanupOldWorkspaces(30);

    assert.deepEqual(result.deleted, [oldAgentId]);
    assert.equal(repository.findById(oldAgentId), undefined);
    assert.ok(repository.findById(recentAgentId));
    assert.equal(fs.existsSync(repository.getAgentDir(oldAgentId)), false);
    assert.equal(fs.existsSync(repository.getWorkspaceDir(oldWorkspaceId)), false);
    assert.equal(fs.existsSync(repository.getAgentDir(recentAgentId)), true);
    assert.equal(fs.existsSync(repository.getWorkspaceDir(recentWorkspaceId)), true);
    assert.equal(fs.existsSync(path.join(workspaceRoot, recentWorkspaceId, 'marker.txt')), true);
  });

  it('skips active sessions and removes orphan workspaces', () => {
    const { service, repository, workspaceRoot } = createTestContext();
    const activeAgentId = 'activesess01';
    const activeWorkspaceId = 'ws-active-1';
    const orphanWorkspaceId = 'ws-orphan-1';

    seedAgent(
      repository,
      baseAgentFields({
        agentId: activeAgentId,
        workspaceId: activeWorkspaceId,
        mode: 'batch',
        status: 'running',
        finishedAt: daysAgo(90),
      }),
    );

    fs.mkdirSync(repository.getWorkspaceDir(activeWorkspaceId), { recursive: true });
    fs.mkdirSync(path.join(workspaceRoot, orphanWorkspaceId), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, orphanWorkspaceId, 'orphan.txt'), 'orphan');

    const result = service.cleanupOldWorkspaces(30);

    assert.deepEqual(result.deleted, []);
    assert.deepEqual(result.skippedActive, [activeAgentId]);
    assert.deepEqual(result.orphanWorkspacesRemoved, [orphanWorkspaceId]);
    assert.ok(repository.findById(activeAgentId));
    assert.equal(fs.existsSync(repository.getWorkspaceDir(activeWorkspaceId)), true);
    assert.equal(fs.existsSync(path.join(workspaceRoot, orphanWorkspaceId)), false);
  });

  it('rejects invalid retention values', () => {
    const { service } = createTestContext();

    assert.throws(
      () => service.cleanupOldWorkspaces(0),
      (err: unknown) => err instanceof CodedError && err.code === 'VALIDATION_ERROR',
    );
  });
});

describe('createPullRequest', () => {
  it('uses local LLM output for PR title and body when configured', async () => {
    const agentId = 'completed00001';
    let capturedTitle = '';
    let capturedBody = '';

    const { service, repository } = createTestContext({
      ollamaChat: {
        generateText: async () => ({
          text: '{"title":"Add webhook retry backoff","body":"## Summary\\n- Added exponential backoff to webhook delivery.\\n\\n## Test plan\\n- [ ] Run webhook sender tests"}',
        }),
      },
      capturePullRequest: ({ title, body }) => {
        capturedTitle = title;
        capturedBody = body;
      },
    });

    seedAgent(
      repository,
      baseAgentFields({
        agentId,
        mode: 'batch',
        status: 'completed',
        agentBranch: 'localagent/retry-webhook',
        branch: 'localagent/retry-webhook',
        commitMessage: 'Add exponential backoff to webhook delivery',
        commitSha: 'deadbeef1234567890abcdef1234567890abcdef',
        pushed: true,
        filesChanged: 2,
        finishedAt: '2026-06-09T00:05:00.000Z',
        result: {
          branch: 'localagent/retry-webhook',
          baseBranch: 'main',
          workspaceId: 'ws-test',
          commitSha: 'deadbeef1234567890abcdef1234567890abcdef',
          pushed: true,
          filesChanged: 2,
          warning: null,
          opencodeSuccess: true,
        },
      }),
    );

    fs.writeFileSync(
      repository.getConversationPath(agentId),
      `${JSON.stringify({ ts: '2026-06-09T00:00:00.000Z', role: 'user', text: 'Add retry logic to the webhook sender' })}\n${JSON.stringify({ ts: '2026-06-09T00:05:00.000Z', role: 'assistant', text: 'Implemented exponential backoff with jitter.' })}\n`,
      'utf8',
    );

    const updated = await service.createPullRequest(agentId);

    assert.equal(capturedTitle, 'Add webhook retry backoff');
    assert.match(capturedBody, /Added exponential backoff to webhook delivery/);
    assert.match(capturedBody, /Local Agent Box session/);
    assert.equal(updated.pullRequest?.number, 42);
    assert.equal(updated.pullRequest?.title, 'Add webhook retry backoff');
  });

  it('falls back to assistant summary from events when conversation lacks it', async () => {
    const agentId = 'completed00002';
    let capturedBody = '';

    const { service, repository } = createTestContext({
      ollamaChat: {
        generateText: async (_config, messages) => {
          const userPrompt = messages.find((message) => message.role === 'user')?.content || '';
          assert.match(userPrompt, /Implemented retries with jitter/);
          return {
            text: '{"title":"Add webhook retries","body":"## Summary\\n- Added retries.\\n\\n## Test plan\\n- [ ] Tests"}',
          };
        },
      },
      capturePullRequest: ({ body }) => {
        capturedBody = body;
      },
    });

    seedAgent(
      repository,
      baseAgentFields({
        agentId,
        mode: 'batch',
        status: 'completed',
        agentBranch: 'localagent/retry-webhook',
        branch: 'localagent/retry-webhook',
        commitSha: 'deadbeef1234567890abcdef1234567890abcdef',
        pushed: true,
        finishedAt: '2026-06-09T00:05:00.000Z',
        result: {
          branch: 'localagent/retry-webhook',
          baseBranch: 'main',
          workspaceId: 'ws-test',
          commitSha: 'deadbeef1234567890abcdef1234567890abcdef',
          pushed: true,
          filesChanged: 2,
          warning: null,
          opencodeSuccess: true,
        },
      }),
    );

    fs.writeFileSync(
      repository.getConversationPath(agentId),
      `${JSON.stringify({ ts: '2026-06-09T00:00:00.000Z', role: 'user', text: 'Add retry logic' })}\n`,
      'utf8',
    );
    fs.writeFileSync(
      repository.getEventsPath(agentId),
      `${JSON.stringify({
        seq: 1,
        ts: '2026-06-09T00:05:00.000Z',
        type: 'assistant.message',
        payload: {
          info: { role: 'assistant' },
          parts: [{ type: 'text', text: 'Implemented retries with jitter.' }],
        },
      })}\n`,
      'utf8',
    );

    await service.createPullRequest(agentId);

    assert.match(capturedBody, /Added retries/);
  });

  it('uses agent.model for PR generation when opencodeModel is unset', async () => {
    const agentId = 'completed00003';
    let capturedModel = '';

    const { service, repository, configRepository } = createTestContext({
      ollamaChat: {
        generateText: async (_config, _messages, model) => {
          capturedModel = model || '';
          return {
            text: '{"title":"Fix webhook retries","body":"## Summary\\n- Fixed retries.\\n\\n## Test plan\\n- [ ] Tests"}',
          };
        },
      },
    });

    configRepository.save({
      ollamaBaseUrl: 'http://localhost:11434',
      opencodeModel: '',
    });

    seedAgent(
      repository,
      baseAgentFields({
        agentId,
        mode: 'batch',
        status: 'completed',
        model: 'qwen2.5-coder:7b',
        agentBranch: 'localagent/retry-webhook',
        branch: 'localagent/retry-webhook',
        commitSha: 'deadbeef1234567890abcdef1234567890abcdef',
        pushed: true,
        finishedAt: '2026-06-09T00:05:00.000Z',
        result: {
          branch: 'localagent/retry-webhook',
          baseBranch: 'main',
          workspaceId: 'ws-test',
          commitSha: 'deadbeef1234567890abcdef1234567890abcdef',
          pushed: true,
          filesChanged: 2,
          warning: null,
          opencodeSuccess: true,
        },
      }),
    );

    await service.createPullRequest(agentId);

    assert.equal(capturedModel, 'qwen2.5-coder:7b');
  });

  it('falls back to assistant summary when LLM generation fails', async () => {
    const agentId = 'completed00004';
    let capturedTitle = '';
    let capturedBody = '';

    const { service, repository } = createTestContext({
      ollamaChat: {
        generateText: async () => ({ text: 'not valid json' }),
      },
      capturePullRequest: ({ title, body }) => {
        capturedTitle = title;
        capturedBody = body;
      },
    });

    seedAgent(
      repository,
      baseAgentFields({
        agentId,
        mode: 'batch',
        status: 'completed',
        agentBranch: 'localagent/retry-webhook',
        branch: 'localagent/retry-webhook',
        commitSha: 'deadbeef1234567890abcdef1234567890abcdef',
        pushed: true,
        finishedAt: '2026-06-09T00:05:00.000Z',
        result: {
          branch: 'localagent/retry-webhook',
          baseBranch: 'main',
          workspaceId: 'ws-test',
          commitSha: 'deadbeef1234567890abcdef1234567890abcdef',
          pushed: true,
          filesChanged: 2,
          warning: null,
          opencodeSuccess: true,
        },
      }),
    );

    fs.writeFileSync(
      repository.getConversationPath(agentId),
      `${JSON.stringify({ ts: '2026-06-09T00:05:00.000Z', role: 'assistant', text: 'Implemented retries with jitter and updated docs.' })}\n`,
      'utf8',
    );

    await service.createPullRequest(agentId);

    assert.equal(capturedTitle, 'Implemented retries with jitter and updated docs.');
    assert.match(capturedBody, /Implemented retries with jitter/);
    assert.match(capturedBody, /Local Agent Box session/);
  });

  it('replaces the model-written test plan with the checks the host ran', async () => {
    const agentId = 'completed00005';
    let capturedBody = '';

    const { service, repository } = createTestContext({
      ollamaChat: {
        generateText: async () => ({
          text: '{"title":"Add webhook retry backoff","body":"## Summary\\n- Added retries.\\n\\n## Test plan\\n- [ ] Run the webhook tests"}',
        }),
      },
      capturePullRequest: ({ body }) => {
        capturedBody = body;
      },
    });

    seedAgent(
      repository,
      baseAgentFields({
        agentId,
        mode: 'batch',
        status: 'needs_attention',
        agentBranch: 'localagent/retry-webhook',
        branch: 'localagent/retry-webhook',
        commitSha: 'deadbeef1234567890abcdef1234567890abcdef',
        pushed: true,
        finishedAt: '2026-06-09T00:05:00.000Z',
        result: {
          branch: 'localagent/retry-webhook',
          baseBranch: 'main',
          workspaceId: 'ws-test',
          commitSha: 'deadbeef1234567890abcdef1234567890abcdef',
          pushed: true,
          filesChanged: 2,
          warning: null,
          opencodeSuccess: true,
        },
        verification: {
          state: 'failed',
          configSource: 'base',
          maxRepairAttempts: 2,
          draftPrOnFailure: true,
          attempts: [
            {
              attempt: 0,
              startedAt: '2026-06-09T00:04:00.000Z',
              finishedAt: '2026-06-09T00:04:30.000Z',
              checks: [
                {
                  name: 'test',
                  command: 'npm test',
                  exitCode: 1,
                  signal: null,
                  timedOut: false,
                  durationMs: 30_000,
                  outputTail: '1 test failed',
                },
              ],
              passed: false,
              failureKind: 'code',
            },
          ],
        },
      }),
    );

    await service.createPullRequest(agentId);

    assert.doesNotMatch(capturedBody, /- \[ \] Run the webhook tests/);
    assert.match(capturedBody, /\| test \| `npm test` \| ❌ exit 1 \| 1 \|/);
    assert.match(capturedBody, /Repair attempts: 0 of 2/);
    assert.match(capturedBody, /\*\*Checks still failing — this draft PR needs attention\.\*\*/);
    assert.ok(capturedBody.indexOf('## Test plan') < capturedBody.indexOf('Local Agent Box session'));
  });

  it('adds the host test plan to an explicit body override', async () => {
    const agentId = 'completed00006';
    let capturedBody = '';

    const { service, repository } = createTestContext({
      capturePullRequest: ({ body }) => {
        capturedBody = body;
      },
    });

    seedAgent(
      repository,
      baseAgentFields({
        agentId,
        mode: 'batch',
        status: 'completed',
        pushed: true,
        finishedAt: '2026-06-09T00:05:00.000Z',
        result: {
          branch: 'localagent-test',
          baseBranch: 'main',
          workspaceId: 'ws-test',
          commitSha: null,
          pushed: true,
          filesChanged: 1,
          warning: null,
          opencodeSuccess: true,
        },
      }),
    );

    await service.createPullRequest(agentId, {
      title: 'Manual title',
      body: 'Manual notes for the reviewer.',
    });

    assert.match(capturedBody, /Manual notes for the reviewer\./);
    assert.match(capturedBody, /^## Test plan$/m);
    assert.match(
      capturedBody,
      /⚠️ Unverified — no build\/lint\/test checks are configured for this repo/,
    );
  });

  it('auto-spawns review agent when auto-review is enabled', async () => {
    const agentId = 'completedreview1';
    const { service, repository, configRepository } = createTestContext();

    configRepository.save({ autoReviewPullRequests: true });

    seedAgent(
      repository,
      baseAgentFields({
        agentId,
        mode: 'batch',
        status: 'completed',
        agentBranch: 'localagent/retry-webhook',
        branch: 'localagent/retry-webhook',
        commitSha: 'deadbeef1234567890abcdef1234567890abcdef',
        pushed: true,
        finishedAt: '2026-06-09T00:05:00.000Z',
        result: {
          branch: 'localagent/retry-webhook',
          baseBranch: 'main',
          workspaceId: 'ws-test',
          commitSha: 'deadbeef1234567890abcdef1234567890abcdef',
          pushed: true,
          filesChanged: 2,
          warning: null,
          opencodeSuccess: true,
        },
      }),
    );

    await service.createPullRequest(agentId);

    const reviewAgents = repository
      .findAll()
      .filter((entry) => entry.mode === 'review' && entry.parentAgentId === agentId);
    assert.equal(reviewAgents.length, 1);
    assert.equal(reviewAgents[0].review?.headBranch, 'localagent/retry-webhook');
    assert.equal(reviewAgents[0].review?.baseBranch, 'main');
  });

  it('skips duplicate auto-review for the same PR head sha', async () => {
    const agentId = 'completedreview2';
    const { service, repository, configRepository } = createTestContext();

    configRepository.save({ autoReviewPullRequests: true });

    seedAgent(
      repository,
      baseAgentFields({
        agentId,
        mode: 'batch',
        status: 'completed',
        agentBranch: 'localagent/retry-webhook',
        branch: 'localagent/retry-webhook',
        commitSha: 'deadbeef1234567890abcdef1234567890abcdef',
        pushed: true,
        finishedAt: '2026-06-09T00:05:00.000Z',
        result: {
          branch: 'localagent/retry-webhook',
          baseBranch: 'main',
          workspaceId: 'ws-test',
          commitSha: 'deadbeef1234567890abcdef1234567890abcdef',
          pushed: true,
          filesChanged: 2,
          warning: null,
          opencodeSuccess: true,
        },
      }),
    );

    repository.save({
      ...baseAgentFields({
        agentId: 'reviewexisting1',
        mode: 'review',
        status: 'completed',
        parentAgentId: agentId,
      }),
      review: {
        baseBranch: 'main',
        headBranch: 'localagent/retry-webhook',
        prNumber: 42,
        headSha: 'deadbeef1234567890abcdef1234567890abcdef',
      },
    });

    await service.createPullRequest(agentId);

    const reviewAgents = repository
      .findAll()
      .filter((entry) => entry.mode === 'review' && entry.parentAgentId === agentId);
    assert.equal(reviewAgents.length, 1);
  });

  it('skips auto-review when a child branch-pair review already exists', async () => {
    const agentId = 'completedreview3';
    const { service, repository, configRepository } = createTestContext();

    configRepository.save({ autoReviewPullRequests: true });

    seedAgent(
      repository,
      baseAgentFields({
        agentId,
        mode: 'batch',
        status: 'completed',
        agentBranch: 'localagent/retry-webhook',
        branch: 'localagent/retry-webhook',
        commitSha: 'deadbeef1234567890abcdef1234567890abcdef',
        pushed: true,
        finishedAt: '2026-06-09T00:05:00.000Z',
        result: {
          branch: 'localagent/retry-webhook',
          baseBranch: 'main',
          workspaceId: 'ws-test',
          commitSha: 'deadbeef1234567890abcdef1234567890abcdef',
          pushed: true,
          filesChanged: 2,
          warning: null,
          opencodeSuccess: true,
        },
      }),
    );

    // Manual review for the same parent/branches — no PR/sha metadata yet,
    // so isDuplicateReview would miss it and createAgent would throw DUPLICATE.
    repository.save({
      ...baseAgentFields({
        agentId: 'reviewexisting2',
        mode: 'review',
        status: 'queued',
        parentAgentId: agentId,
      }),
      review: {
        baseBranch: 'main',
        headBranch: 'localagent/retry-webhook',
      },
    });

    const updated = await service.createPullRequest(agentId);

    assert.ok(updated.pullRequest);
    assert.equal(updated.pullRequest?.number, 42);

    const reviewAgents = repository
      .findAll()
      .filter((entry) => entry.mode === 'review' && entry.parentAgentId === agentId);
    assert.equal(reviewAgents.length, 1);
    assert.equal(reviewAgents[0].agentId, 'reviewexisting2');
  });

  it('allows a new review after a completed branch-pair review', async () => {
    const agentId = 'completedreview4';
    const { service, repository, configRepository } = createTestContext();

    configRepository.save({ autoReviewPullRequests: true });

    seedAgent(
      repository,
      baseAgentFields({
        agentId,
        mode: 'batch',
        status: 'completed',
        agentBranch: 'localagent/retry-webhook',
        branch: 'localagent/retry-webhook',
        commitSha: 'deadbeef1234567890abcdef1234567890abcdef',
        pushed: true,
        finishedAt: '2026-06-09T00:05:00.000Z',
        result: {
          branch: 'localagent/retry-webhook',
          baseBranch: 'main',
          workspaceId: 'ws-test',
          commitSha: 'deadbeef1234567890abcdef1234567890abcdef',
          pushed: true,
          filesChanged: 2,
          warning: null,
          opencodeSuccess: true,
        },
      }),
    );

    repository.save({
      ...baseAgentFields({
        agentId: 'reviewexisting3',
        mode: 'review',
        status: 'completed',
        parentAgentId: agentId,
      }),
      review: {
        baseBranch: 'main',
        headBranch: 'localagent/retry-webhook',
      },
    });

    const reviewAgent = service.createAgent({
      repoId: testRepo.repoId,
      mode: 'review',
      prompt: '',
      baseBranch: 'main',
      headBranch: 'localagent/retry-webhook',
      parentAgentId: agentId,
    });

    assert.equal(reviewAgent.mode, 'review');
    assert.equal(reviewAgent.parentAgentId, agentId);
    assert.equal(reviewAgent.status, 'queued');
  });

  it('defaults review agent model to reviewModel from settings when not overridden', () => {
    const { service, configRepository } = createTestContext();

    configRepository.save({
      opencodeModel: 'qwen2.5-coder:7b',
      reviewModel: 'llama3.2',
    });

    const reviewAgent = service.createAgent({
      repoId: testRepo.repoId,
      mode: 'review',
      prompt: '',
      baseBranch: 'main',
      headBranch: 'feature/review-model',
      parentAgentId: 'parent-agent',
    });

    assert.equal(reviewAgent.model, 'llama3.2');
  });

  it('treats whitespace-only model override as unset for review agents', () => {
    const { service, configRepository } = createTestContext();

    configRepository.save({
      opencodeModel: 'qwen2.5-coder:7b',
      reviewModel: 'llama3.2',
    });

    const reviewAgent = service.createAgent({
      repoId: testRepo.repoId,
      mode: 'review',
      prompt: '',
      baseBranch: 'main',
      headBranch: 'feature/review-model',
      parentAgentId: 'parent-agent',
      model: '   ',
    });

    assert.equal(reviewAgent.model, 'llama3.2');
  });

  it('skips auto-review while a coding successor is still queued on the branch', async () => {
    const agentId = 'completedreview5';
    const { service, repository, configRepository } = createTestContext();

    configRepository.save({ autoReviewPullRequests: true });

    seedAgent(
      repository,
      baseAgentFields({
        agentId,
        mode: 'batch',
        status: 'completed',
        agentBranch: 'feature/project',
        branch: 'feature/project',
        commitSha: 'deadbeef1234567890abcdef1234567890abcdef',
        pushed: true,
        finishedAt: '2026-06-09T00:05:00.000Z',
        result: {
          branch: 'feature/project',
          baseBranch: 'main',
          workspaceId: 'ws-test',
          commitSha: 'deadbeef1234567890abcdef1234567890abcdef',
          pushed: true,
          filesChanged: 2,
          warning: null,
          opencodeSuccess: true,
        },
      }),
    );
    seedAgent(
      repository,
      baseAgentFields({
        agentId: 'queued-chunk-2',
        mode: 'batch',
        status: 'queued',
        agentBranch: 'feature/project',
        createdAt: '2026-06-09T00:06:00.000Z',
        startedAt: null,
      }),
    );

    await service.createPullRequest(agentId);

    const reviewAgents = repository.findAll().filter((entry) => entry.mode === 'review');
    assert.equal(reviewAgents.length, 0);
    const log = fs.readFileSync(repository.getLogPath(agentId), 'utf8');
    assert.match(log, /Skipping auto-review — coding session still queued or running on feature\/project/);
  });

  it('auto-spawns review when earlier chunks on the branch are already complete', async () => {
    const agentId = 'completedreview6';
    const { service, repository, configRepository } = createTestContext();

    configRepository.save({ autoReviewPullRequests: true });

    seedAgent(
      repository,
      baseAgentFields({
        agentId: 'completed-chunk-1',
        mode: 'batch',
        status: 'completed',
        agentBranch: 'feature/project',
        branch: 'feature/project',
        pushed: true,
        createdAt: '2026-06-09T00:00:00.000Z',
        finishedAt: '2026-06-09T00:05:00.000Z',
      }),
    );
    seedAgent(
      repository,
      baseAgentFields({
        agentId,
        mode: 'batch',
        status: 'completed',
        agentBranch: 'feature/project',
        branch: 'feature/project',
        commitSha: 'deadbeef1234567890abcdef1234567890abcdef',
        pushed: true,
        createdAt: '2026-06-09T00:06:00.000Z',
        finishedAt: '2026-06-09T00:10:00.000Z',
        result: {
          branch: 'feature/project',
          baseBranch: 'main',
          workspaceId: 'ws-test',
          commitSha: 'deadbeef1234567890abcdef1234567890abcdef',
          pushed: true,
          filesChanged: 2,
          warning: null,
          opencodeSuccess: true,
        },
      }),
    );

    await service.createPullRequest(agentId);

    const reviewAgents = repository
      .findAll()
      .filter((entry) => entry.mode === 'review' && entry.parentAgentId === agentId);
    assert.equal(reviewAgents.length, 1);
  });
});

describe('createAgentService (shared-branch queue)', () => {
  it('allows a second session on the same branch and keeps it queued', () => {
    const ctx = createTestContext();

    const first = ctx.service.createAgent({
      repoId: testRepo.repoId,
      prompt: 'Chunk 1',
      agentBranch: 'feature/project',
    });
    const second = ctx.service.createAgent({
      repoId: testRepo.repoId,
      prompt: 'Chunk 2',
      agentBranch: 'feature/project',
    });

    assert.equal(first.status, 'queued');
    assert.equal(second.status, 'queued');
    assert.equal(first.agentBranch, 'feature/project');
    assert.equal(second.agentBranch, 'feature/project');
    assert.equal(hasStartedWorker(ctx, first.agentId), true);
    assert.equal(hasStartedWorker(ctx, second.agentId), false);
  });

  it('starts the next same-branch session after the predecessor completes and pushes', () => {
    const ctx = createTestContext();

    const first = ctx.service.createAgent({
      repoId: testRepo.repoId,
      prompt: 'Chunk 1',
      agentBranch: 'feature/project',
    });
    const second = ctx.service.createAgent({
      repoId: testRepo.repoId,
      prompt: 'Chunk 2',
      agentBranch: 'feature/project',
    });

    ctx.repository.update(first.agentId, {
      status: 'completed',
      pushed: true,
      finishedAt: new Date().toISOString(),
    });
    ctx.spawned[0].emitExit(0);

    assert.equal(hasStartedWorker(ctx, second.agentId), true);
  });

  it('does not start the next same-branch session when the predecessor failed', () => {
    const ctx = createTestContext();

    const first = ctx.service.createAgent({
      repoId: testRepo.repoId,
      prompt: 'Chunk 1',
      agentBranch: 'feature/project',
    });
    const second = ctx.service.createAgent({
      repoId: testRepo.repoId,
      prompt: 'Chunk 2',
      agentBranch: 'feature/project',
    });

    ctx.repository.update(first.agentId, {
      status: 'failed',
      pushed: false,
      finishedAt: new Date().toISOString(),
      error: 'boom',
    });
    ctx.spawned[0].emitExit(1);

    assert.equal(hasStartedWorker(ctx, second.agentId), false);
    assert.equal(ctx.service.getAgent(second.agentId).status, 'queued');
  });

  it('starts a different-branch session while a same-branch successor is blocked', () => {
    const ctx = createTestContext({ maxConcurrent: 2 });

    const first = ctx.service.createAgent({
      repoId: testRepo.repoId,
      prompt: 'Chunk 1',
      agentBranch: 'feature/project',
    });
    const blocked = ctx.service.createAgent({
      repoId: testRepo.repoId,
      prompt: 'Chunk 2',
      agentBranch: 'feature/project',
    });
    const other = ctx.service.createAgent({
      repoId: testRepo.repoId,
      prompt: 'Unrelated',
      agentBranch: 'feature/other',
    });

    assert.equal(hasStartedWorker(ctx, first.agentId), true);
    assert.equal(hasStartedWorker(ctx, blocked.agentId), false);
    assert.equal(hasStartedWorker(ctx, other.agentId), true);
  });

  it('forces push on a chained session even when create requested push false', () => {
    const ctx = createTestContext();

    const first = ctx.service.createAgent({
      repoId: testRepo.repoId,
      prompt: 'Chunk 1',
      agentBranch: 'feature/project',
      push: false,
    });
    const second = ctx.service.createAgent({
      repoId: testRepo.repoId,
      prompt: 'Chunk 2',
      agentBranch: 'feature/project',
      push: false,
    });

    assert.equal(first.push, false);
    assert.equal(second.push, true);
  });

  it('does not force push on a review session sharing the branch', () => {
    const ctx = createTestContext({ maxConcurrent: 2 });

    ctx.service.createAgent({
      repoId: testRepo.repoId,
      prompt: 'Chunk 1',
      agentBranch: 'feature/project',
    });
    const review = ctx.service.createAgent({
      repoId: testRepo.repoId,
      mode: 'review',
      prompt: '',
      baseBranch: 'main',
      headBranch: 'feature/project',
      parentAgentId: 'parent1',
    });

    assert.equal(review.push, false);
  });

  it('attaches queue wait reason on a blocked successor', () => {
    const ctx = createTestContext();

    const first = ctx.service.createAgent({
      repoId: testRepo.repoId,
      prompt: 'Chunk 1',
      agentBranch: 'feature/project',
    });
    const second = ctx.service.createAgent({
      repoId: testRepo.repoId,
      prompt: 'Chunk 2',
      agentBranch: 'feature/project',
    });

    const queued = ctx.service.getAgent(second.agentId);
    assert.equal(queued.queue?.waitingOn, 'predecessor');
    assert.equal(queued.queue?.predecessorId, first.agentId);
    assert.equal(queued.queue?.canRetry, false);
    assert.equal(ctx.service.getAgent(first.agentId).queue?.waitingOn, null);
  });

  it('retries a failed session in place and starts it before later chunks', () => {
    const ctx = createTestContext();

    const first = ctx.service.createAgent({
      repoId: testRepo.repoId,
      prompt: 'Chunk 1',
      agentBranch: 'feature/project',
    });
    const second = ctx.service.createAgent({
      repoId: testRepo.repoId,
      prompt: 'Chunk 2',
      agentBranch: 'feature/project',
    });

    ctx.repository.update(first.agentId, {
      status: 'failed',
      pushed: false,
      finishedAt: new Date().toISOString(),
      error: 'boom',
    });
    ctx.spawned[0].emitExit(1);

    const retried = ctx.service.retryAgent(first.agentId);
    assert.equal(retried.status, 'queued');
    assert.equal(retried.error, null);
    assert.equal(retried.allowSuccessors, false);
    assert.equal(ctx.spawned.length, 2);
    assert.equal(hasStartedWorker(ctx, second.agentId), false);
  });

  it('retry moves the agent to a fresh workspace and removes the old one', () => {
    const ctx = createTestContext();
    const agent = ctx.service.createAgent({
      repoId: testRepo.repoId,
      prompt: 'Chunk 1',
      agentBranch: 'feature/project',
    });
    const oldWorkspaceDir = ctx.repository.getWorkspaceDir(agent.workspaceId);
    fs.writeFileSync(path.join(oldWorkspaceDir, 'leftover.txt'), 'x', 'utf8');

    ctx.repository.update(agent.agentId, { status: 'failed', error: 'boom' });
    ctx.spawned[0].emitExit(1);

    const retried = ctx.service.retryAgent(agent.agentId);
    assert.notEqual(retried.workspaceId, agent.workspaceId);
    assert.equal(fs.existsSync(oldWorkspaceDir), false);
    assert.equal(fs.existsSync(ctx.repository.getWorkspaceDir(retried.workspaceId)), true);
    const job = JSON.parse(
      fs.readFileSync(path.join(ctx.repository.getAgentDir(agent.agentId), 'job.json'), 'utf8'),
    );
    assert.equal(job.workspaceDir, ctx.repository.getWorkspaceDir(retried.workspaceId));
  });

  it('does not start a retry until the cancelled worker has actually exited', () => {
    const ctx = createTestContext();
    const agent = ctx.service.createAgent({
      repoId: testRepo.repoId,
      prompt: 'Chunk 1',
      agentBranch: 'feature/project',
    });
    assert.equal(ctx.spawned.length, 1);

    ctx.service.cancelAgent(agent.agentId);
    const retried = ctx.service.retryAgent(agent.agentId);
    assert.equal(retried.status, 'queued');
    assert.equal(ctx.spawned.length, 1, 'old worker is still exiting');

    ctx.spawned[0].emitExit(null, 'SIGTERM');
    assert.equal(ctx.spawned.length, 2);
    assert.equal(ctx.service.getAgent(agent.agentId).status, 'queued');
  });

  it('rejects retry unless the session is failed or cancelled', () => {
    const ctx = createTestContext();
    const agent = ctx.service.createAgent({
      repoId: testRepo.repoId,
      prompt: 'Chunk 1',
      agentBranch: 'feature/project',
    });
    assert.throws(() => ctx.service.retryAgent(agent.agentId), (err: unknown) => {
      assert.ok(err instanceof CodedError);
      assert.equal(err.code, 'NOT_ACTIVE');
      return true;
    });
  });

  it('rejects retrying or releasing a legacy record', () => {
    const ctx = createTestContext();
    seedAgent(
      ctx.repository,
      baseAgentFields({
        agentId: 'legacy0000009',
        mode: 'loop',
        status: 'failed',
        agentBranch: 'feature/project',
        error: 'boom',
      }),
    );

    for (const action of [() => ctx.service.retryAgent('legacy0000009'), () => ctx.service.allowSuccessors('legacy0000009')]) {
      assert.throws(action, (err: unknown) => {
        assert.ok(err instanceof CodedError);
        assert.equal(err.code, 'VALIDATION_ERROR');
        assert.match(String(err.message), /Legacy loop sessions are read-only/);
        return true;
      });
    }
    assert.equal(ctx.service.getAgent('legacy0000009').status, 'failed');
    assert.equal(ctx.spawned.length, 0);
  });

  it('starts the next queued session after allowSuccessors on a failed predecessor', () => {
    const ctx = createTestContext();

    const first = ctx.service.createAgent({
      repoId: testRepo.repoId,
      prompt: 'Chunk 1',
      agentBranch: 'feature/project',
    });
    const second = ctx.service.createAgent({
      repoId: testRepo.repoId,
      prompt: 'Chunk 2',
      agentBranch: 'feature/project',
    });

    ctx.repository.update(first.agentId, {
      status: 'failed',
      pushed: false,
      finishedAt: new Date().toISOString(),
      error: 'boom',
    });
    ctx.spawned[0].emitExit(1);

    const result = ctx.service.allowSuccessors(first.agentId);
    assert.equal(result.agent.allowSuccessors, true);
    assert.match(result.warning || '', /will not include this session/);
    assert.equal(hasStartedWorker(ctx, second.agentId), true);
  });
});

describe('restoreOnStartup', () => {
  it('re-enqueues queued agents and starts the first eligible one', async () => {
    const ctx = createTestContext();
    seedAgent(
      ctx.repository,
      baseAgentFields({
        agentId: 'queued0000001',
        mode: 'batch',
        status: 'queued',
        agentBranch: 'feature/project',
        createdAt: '2026-08-16T00:00:01.000Z',
        startedAt: null,
      }),
    );

    await ctx.service.restoreOnStartup();

    assert.equal(ctx.service.getAgent('queued0000001').status, 'queued');
    assert.equal(hasStartedWorker(ctx, 'queued0000001'), true);
  });

  it('re-enqueues only after startup reconciliation completes', async () => {
    const ctx = createTestContext();
    seedAgent(
      ctx.repository,
      baseAgentFields({
        agentId: 'queued0000003',
        mode: 'batch',
        status: 'queued',
        agentBranch: 'feature/project',
        createdAt: '2026-08-16T00:00:01.000Z',
        startedAt: null,
      }),
    );

    const pending = ctx.service.restoreOnStartup();
    // Re-enqueueing must wait for the reconcile: a worker started early would
    // look like a stuck batch (running with no live worker) to the in-flight
    // reconciliation.
    assert.equal(hasStartedWorker(ctx, 'queued0000003'), false);
    await pending;
    assert.equal(hasStartedWorker(ctx, 'queued0000003'), true);
  });

  it('fails in-progress agents but keeps later queued chunks waiting', async () => {
    const ctx = createTestContext();
    seedAgent(
      ctx.repository,
      baseAgentFields({
        agentId: 'running000001',
        mode: 'batch',
        status: 'running',
        agentBranch: 'feature/project',
        createdAt: '2026-08-16T00:00:01.000Z',
      }),
    );
    seedAgent(
      ctx.repository,
      baseAgentFields({
        agentId: 'queued0000002',
        mode: 'batch',
        status: 'queued',
        agentBranch: 'feature/project',
        createdAt: '2026-08-16T00:00:02.000Z',
        startedAt: null,
      }),
    );

    await ctx.service.restoreOnStartup();

    const failed = ctx.service.getAgent('running000001');
    assert.equal(failed.status, 'failed');
    assert.match(failed.error || '', /Server restarted/);
    assert.equal(ctx.service.getAgent('queued0000002').status, 'queued');
    assert.equal(hasStartedWorker(ctx, 'queued0000002'), false);
  });

  it('fails a legacy record that was left in an active status', async () => {
    const ctx = createTestContext();
    seedAgent(
      ctx.repository,
      baseAgentFields({
        agentId: 'legacy0000001',
        mode: 'interactive',
        status: 'awaiting_input',
        agentBranch: 'feature/project',
        createdAt: '2026-08-16T00:00:01.000Z',
      }),
    );

    await ctx.service.restoreOnStartup();

    const failed = ctx.service.getAgent('legacy0000001');
    assert.equal(failed.status, 'failed');
    assert.match(failed.error || '', /Legacy interactive session stopped by v1 upgrade/);
    assert.equal(hasStartedWorker(ctx, 'legacy0000001'), false);
  });

  it('starts queued sessions in createdAt order across branches', async () => {
    const ctx = createTestContext({ maxConcurrent: 2 });
    seedAgent(
      ctx.repository,
      baseAgentFields({
        agentId: 'queued-a',
        mode: 'batch',
        status: 'queued',
        agentBranch: 'feature/a',
        createdAt: '2026-08-16T00:00:02.000Z',
        startedAt: null,
      }),
    );
    seedAgent(
      ctx.repository,
      baseAgentFields({
        agentId: 'queued-b',
        mode: 'batch',
        status: 'queued',
        agentBranch: 'feature/b',
        createdAt: '2026-08-16T00:00:01.000Z',
        startedAt: null,
      }),
    );

    await ctx.service.restoreOnStartup();

    assert.equal(hasStartedWorker(ctx, 'queued-b'), true);
    assert.equal(hasStartedWorker(ctx, 'queued-a'), true);
  });

  it('reconciles an interrupted autofix plan: queued fix agent re-enqueued, missing agent paused', async () => {
    const ctx = createTestContext();

    const writePlan = (
      reviewId: string,
      chainStatus: 'running' | 'paused',
      batches: Array<{ index: number; agentId: string | null; status: 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'skipped' }>,
      nextBatchIndex: number | null,
    ): void => {
      ctx.repository.writeReviewAutofixPlan(reviewId, {
        schemaVersion: 1,
        snapshot: {
          severityThreshold: 'high',
          maxFindingsPerBatch: 5,
          reviewedSha: 'sha-old',
          baseBranch: 'main',
          headBranch: 'feature/project',
          prNumber: null,
          snapshottedAt: '2026-08-16T00:00:00.000Z',
        },
        chainStatus,
        batches: batches.map((batch) => ({
          ...batch,
          findingIds: [`${reviewId}:finding:${batch.index}`],
        })),
        nextBatchIndex,
        verification: { status: 'none', agentId: null },
      });
    };

    // Review A: chain running, batch 0 queued under a surviving fix agent —
    // restoreOnStartup re-enqueues it and the chain stays running.
    seedAgent(
      ctx.repository,
      baseAgentFields({
        agentId: 'reviewa00001',
        mode: 'review',
        status: 'completed',
        agentBranch: 'feature/project',
        review: { baseBranch: 'main', headBranch: 'feature/project', prNumber: null, headSha: null },
      }),
    );
    writePlan('reviewa00001', 'running', [{ index: 0, agentId: 'fixqueued01', status: 'queued' }], null);
    seedAgent(
      ctx.repository,
      baseAgentFields({
        agentId: 'fixqueued01',
        mode: 'batch',
        status: 'queued',
        agentBranch: 'feature/project',
        createdAt: '2026-08-16T00:00:01.000Z',
        startedAt: null,
        autofix: {
          kind: 'automatic',
          sourceReviewAgentId: 'reviewa00001',
          findingIds: ['reviewa00001:finding:0'],
          batchIndex: 0,
        },
      }),
    );

    // Review B: chain running, batch 0 queued under an agent whose record is
    // gone — the batch is failed and the chain paused (no duplicate creation).
    seedAgent(
      ctx.repository,
      baseAgentFields({
        agentId: 'reviewb00001',
        mode: 'review',
        status: 'completed',
        agentBranch: 'feature/other',
        review: { baseBranch: 'main', headBranch: 'feature/other', prNumber: null, headSha: null },
      }),
    );
    writePlan('reviewb00001', 'running', [{ index: 0, agentId: 'fixghost001', status: 'queued' }], null);

    await ctx.service.restoreOnStartup();

    const planA = ctx.repository.readReviewAutofixPlan('reviewa00001');
    assert.equal(planA?.chainStatus, 'running');
    assert.equal(planA?.batches[0].status, 'queued');
    assert.equal(planA?.batches[0].agentId, 'fixqueued01');
    // The surviving queued fix agent was re-enqueued for the worker pipeline.
    assert.equal(ctx.service.getAgent('fixqueued01').status, 'queued');

    const planB = ctx.repository.readReviewAutofixPlan('reviewb00001');
    assert.equal(planB?.chainStatus, 'paused');
    assert.equal(planB?.batches[0].status, 'failed');
    assert.equal(planB?.nextBatchIndex, null);
  });

  it('catches and logs a throwing reconcile path instead of rejecting at startup', async () => {
    const ctx = createTestContext();
    seedAgent(
      ctx.repository,
      baseAgentFields({
        agentId: 'reviewboom01',
        mode: 'review',
        status: 'completed',
        agentBranch: 'feature/project',
        review: { baseBranch: 'main', headBranch: 'feature/project', prNumber: null, headSha: null },
      }),
    );
    seedAgent(
      ctx.repository,
      baseAgentFields({
        agentId: 'queued0000010',
        mode: 'batch',
        status: 'queued',
        agentBranch: 'feature/project',
        createdAt: '2026-08-16T00:00:03.000Z',
        startedAt: null,
      }),
    );

    // Throw sites in the reconcile path (e.g. config load / getAgent NOT_FOUND)
    // must be caught by startup: otherwise the rejection terminates the process.
    const originalReadPlan = ctx.repository.readReviewAutofixPlan.bind(ctx.repository);
    ctx.repository.readReviewAutofixPlan = (agentId: string) => {
      if (agentId === 'reviewboom01') {
        throw new Error('plan read failed');
      }
      return originalReadPlan(agentId);
    };

    const logger = getLogger();
    const originalWarn = logger.warn;
    const logged: Array<{ obj: unknown; msg?: string }> = [];
    logger.warn = ((obj: unknown, msg?: string) => {
      logged.push({ obj, msg });
      return logger;
    }) as typeof logger.warn;

    try {
      await ctx.service.restoreOnStartup();
      const entry = logged.find((item) => item.msg?.includes('Startup autofix reconcile failed'));
      assert.ok(entry);
      assert.equal((entry?.obj as { err?: Error })?.err?.message, 'plan read failed');
      // Startup still proceeds: the queued agent is re-enqueued despite the failure.
      assert.equal(hasStartedWorker(ctx, 'queued0000010'), true);
    } finally {
      logger.warn = originalWarn;
    }
  });
});


describe('review check-run reconciliation', () => {
  async function flushAsync(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }

  function reviewWithCheck(): Agent['review'] {
    return {
      baseBranch: 'main',
      headBranch: 'feature',
      prNumber: 7,
      headSha: 'sha123',
      githubCheckRunId: 555,
      githubCheckHeadSha: 'sha123',
      githubCheckConclusion: null,
    };
  }

  it('cancelAgent PATCHes the review check run to cancelled', async () => {
    const { service, repository } = createTestContext();
    const agentId = 'reviewcxl01';
    seedAgent(
      repository,
      baseAgentFields({
        agentId,
        mode: 'review',
        status: 'running',
        agentBranch: 'feature',
        review: reviewWithCheck(),
      }),
    );

    const updated = service.cancelAgent(agentId);

    assert.equal(updated.status, 'cancelled');
    await flushAsync();
    assert.equal(repository.findById(agentId)?.review?.githubCheckConclusion, 'cancelled');
  });

  it('cancelAgent skips the check PATCH when the repo is unregistered', async () => {
    const { service, repository } = createTestContext();
    const agentId = 'reviewcxl02';
    const agent = baseAgentFields({
      agentId,
      mode: 'review',
      status: 'running',
      agentBranch: 'feature',
      review: reviewWithCheck(),
    });
    agent.repoId = 'missing-repo';
    seedAgent(repository, agent);

    const updated = service.cancelAgent(agentId);

    assert.equal(updated.status, 'cancelled');
    await flushAsync();
    // Unknown repo → no PATCH target; local state must not claim cancelled.
    assert.equal(repository.findById(agentId)?.review?.githubCheckConclusion, null);
  });

  it('cancelAgent skips the check PATCH when the worker already completed the check', async () => {
    const { service, repository } = createTestContext();
    const agentId = 'reviewcxl03';
    seedAgent(
      repository,
      baseAgentFields({
        agentId,
        mode: 'review',
        status: 'running',
        agentBranch: 'feature',
        review: reviewWithCheck(),
      }),
    );

    // Simulate the worker persisting a terminal conclusion (its own process
    // writes agents.json) between the snapshot taken in cancelAgent and the
    // fresh re-read at the top of cancelReviewCheckRun: the first findById
    // call (the gate re-read) observes the worker's conclusion.
    const originalFindById = repository.findById.bind(repository);
    let findByIdCalls = 0;
    repository.findById = (id: string) => {
      findByIdCalls += 1;
      if (findByIdCalls === 1 && id === agentId) {
        repository.update(agentId, {
          review: { ...reviewWithCheck(), githubCheckConclusion: 'success' } as AgentReviewMetadata,
        });
      }
      return originalFindById(id);
    };

    const updated = service.cancelAgent(agentId);

    assert.equal(updated.status, 'cancelled');
    await flushAsync();
    // The worker's conclusion must not be clobbered with 'cancelled'.
    assert.equal(repository.findById(agentId)?.review?.githubCheckConclusion, 'success');
  });

  it('restoreOnStartup PATCHes cancelled for interrupted review agents', async () => {
    const { service, repository } = createTestContext();
    const agentId = 'reviewintr01';
    seedAgent(
      repository,
      baseAgentFields({
        agentId,
        mode: 'review',
        status: 'running',
        agentBranch: 'feature',
        review: reviewWithCheck(),
      }),
    );

    await service.restoreOnStartup();

    const failed = service.getAgent(agentId);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error || '', /Server restarted/);
    await flushAsync();
    assert.equal(repository.findById(agentId)?.review?.githubCheckConclusion, 'cancelled');
  });

  it('worker SIGTERM exit PATCHes the review check run to cancelled', async () => {
    const ctx = createTestContext();
    const agent = ctx.service.createAgent({
      repoId: testRepo.repoId,
      prompt: 'Review the diff',
      mode: 'review',
      headBranch: 'feature',
    });
    const agentId = agent.agentId;
    ctx.repository.update(agentId, {
      status: 'running',
      review: {
        ...agent.review,
        prNumber: 7,
        headSha: 'sha123',
        githubCheckRunId: 555,
        githubCheckHeadSha: 'sha123',
        githubCheckConclusion: null,
      } as AgentReviewMetadata,
    });
    assert.equal(ctx.spawned.length, 1);

    ctx.spawned[0].emitExit(null, 'SIGTERM');

    assert.equal(ctx.service.getAgent(agentId).status, 'cancelled');
    await flushAsync();
    assert.equal(ctx.repository.findById(agentId)?.review?.githubCheckConclusion, 'cancelled');
  });

  it('worker nonzero exit PATCHes the review check run to cancelled', async () => {
    const ctx = createTestContext();
    const agent = ctx.service.createAgent({
      repoId: testRepo.repoId,
      prompt: 'Review the diff',
      mode: 'review',
      headBranch: 'feature',
    });
    const agentId = agent.agentId;
    ctx.repository.update(agentId, {
      status: 'running',
      review: {
        ...agent.review,
        prNumber: 7,
        headSha: 'sha123',
        githubCheckRunId: 555,
        githubCheckHeadSha: 'sha123',
        githubCheckConclusion: null,
      } as AgentReviewMetadata,
    });
    assert.equal(ctx.spawned.length, 1);

    ctx.spawned[0].emitExit(137, null);

    assert.equal(ctx.service.getAgent(agentId).status, 'failed');
    await flushAsync();
    assert.equal(ctx.repository.findById(agentId)?.review?.githubCheckConclusion, 'cancelled');
  });

  it('retryAgent preserves the check-run id until the fresh run is created', () => {
    const { service, repository } = createTestContext();
    const agentId = 'reviewretry01';
    seedAgent(
      repository,
      baseAgentFields({
        agentId,
        mode: 'review',
        status: 'failed',
        agentBranch: 'feature',
        review: reviewWithCheck(),
      }),
    );

    const retried = service.retryAgent(agentId);

    assert.equal(retried.status, 'queued');
    const review = repository.findById(agentId)?.review;
    // The previous attempt's check run (possibly still in_progress on GitHub
    // after a worker crash) stays reconcilable until startReviewCheck
    // overwrites it with the freshly created run.
    assert.equal(review?.githubCheckRunId ?? null, 555);
    assert.equal(review?.githubCheckHeadSha ?? null, 'sha123');
    assert.equal(review?.githubCheckConclusion ?? null, null);
    // Non-check review metadata must survive the retry.
    assert.equal(review?.baseBranch, 'main');
    assert.equal(review?.headBranch, 'feature');
    assert.equal(review?.prNumber, 7);
    assert.equal(review?.headSha, 'sha123');
  });

  it('retryAgent leaves non-review agents untouched by check metadata resets', () => {
    const { service, repository } = createTestContext();
    const agentId = 'batchretry01';
    seedAgent(
      repository,
      baseAgentFields({ agentId, mode: 'batch', status: 'failed', agentBranch: 'feature' }),
    );

    const retried = service.retryAgent(agentId);

    assert.equal(retried.status, 'queued');
    assert.equal(repository.findById(agentId)?.review, undefined);
  });
});

describe('createAgentService (per-repo webhook endpoint)', () => {
  function makeWebhookCapture(): {
    webhookSender: WebhookSender;
    deliveries: Array<{ url: string; data: unknown }>;
  } {
    const deliveries: Array<{ url: string; data: unknown }> = [];
    const webhookSender: WebhookSender = {
      sendWebhook: async (url, data) => {
        deliveries.push({ url, data });
        return undefined;
      },
    };
    return { webhookSender, deliveries };
  }

  it('falls back to the global webhook url when the repo has no override', () => {
    const { webhookSender, deliveries } = makeWebhookCapture();
    const ctx = createTestContext({ webhookSender });
    ctx.configRepository.save({ webhookUrl: 'https://hooks.example.com/global-agent' });

    const agent = ctx.service.createAgent({ repoId: testRepo.repoId, prompt: 'Refactor auth' });
    ctx.repository.update(agent.agentId, {
      status: 'completed',
      pushed: true,
      finishedAt: new Date().toISOString(),
    });
    ctx.spawned[0].emitExit(0);

    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].url, 'https://hooks.example.com/global-agent');
    assert.equal((deliveries[0].data as { event: string }).event, 'agent.completed');
    assert.equal((deliveries[0].data as { agent: Agent }).agent.agentId, agent.agentId);
  });

  it('delivers to the repo endpoint even when the global url is empty', () => {
    const { webhookSender, deliveries } = makeWebhookCapture();
    const ctx = createTestContext({
      webhookSender,
      repoOverride: { webhookUrl: 'https://hooks.example.com/repo-agent' },
    });

    const agent = ctx.service.createAgent({ repoId: testRepo.repoId, prompt: 'Refactor auth' });
    ctx.repository.update(agent.agentId, {
      status: 'completed',
      pushed: true,
      finishedAt: new Date().toISOString(),
    });
    ctx.spawned[0].emitExit(0);

    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].url, 'https://hooks.example.com/repo-agent');
  });

  it('prefers the repo override over the configured global url', () => {
    const { webhookSender, deliveries } = makeWebhookCapture();
    const ctx = createTestContext({
      webhookSender,
      repoOverride: { webhookUrl: 'https://hooks.example.com/repo-agent' },
    });
    ctx.configRepository.save({ webhookUrl: 'https://hooks.example.com/global-agent' });

    const agent = ctx.service.createAgent({ repoId: testRepo.repoId, prompt: 'Refactor auth' });
    ctx.repository.update(agent.agentId, {
      status: 'completed',
      pushed: true,
      finishedAt: new Date().toISOString(),
    });
    ctx.spawned[0].emitExit(0);

    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].url, 'https://hooks.example.com/repo-agent');
  });

  it('falls back to the global url when the repo lookup fails', () => {
    const { webhookSender, deliveries } = makeWebhookCapture();
    const repoLookup = { fail: false };
    const ctx = createTestContext({
      webhookSender,
      repoLookup,
      repoOverride: { webhookUrl: 'https://hooks.example.com/repo-agent' },
    });
    ctx.configRepository.save({ webhookUrl: 'https://hooks.example.com/global-agent' });

    const agent = ctx.service.createAgent({ repoId: testRepo.repoId, prompt: 'Refactor auth' });
    ctx.repository.update(agent.agentId, {
      status: 'completed',
      pushed: true,
      finishedAt: new Date().toISOString(),
    });
    repoLookup.fail = true;
    ctx.spawned[0].emitExit(0);

    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].url, 'https://hooks.example.com/global-agent');
  });

  it('skips delivery when neither the repo nor the global setting has a url', () => {
    const { webhookSender, deliveries } = makeWebhookCapture();
    const ctx = createTestContext({ webhookSender });

    const agent = ctx.service.createAgent({ repoId: testRepo.repoId, prompt: 'Refactor auth' });
    ctx.repository.update(agent.agentId, {
      status: 'completed',
      pushed: true,
      finishedAt: new Date().toISOString(),
    });
    ctx.spawned[0].emitExit(0);

    assert.equal(deliveries.length, 0);
  });

  it('sends agent.needs_attention for a run whose repair attempts ran out', () => {
    const { webhookSender, deliveries } = makeWebhookCapture();
    const ctx = createTestContext({ webhookSender });
    ctx.configRepository.save({ webhookUrl: 'https://hooks.example.com/global-agent' });

    const agent = ctx.service.createAgent({ repoId: testRepo.repoId, prompt: 'Refactor auth' });
    ctx.repository.update(agent.agentId, {
      status: 'needs_attention',
      pushed: true,
      finishedAt: new Date().toISOString(),
      verification: {
        state: 'failed',
        configSource: 'base',
        maxRepairAttempts: 2,
        draftPrOnFailure: false,
        attempts: [],
      },
    });
    ctx.spawned[0].emitExit(1);

    assert.equal(deliveries.length, 1);
    assert.equal((deliveries[0].data as { event: string }).event, 'agent.needs_attention');
  });

  it('sends agent.failed for a machine failure', () => {
    const { webhookSender, deliveries } = makeWebhookCapture();
    const ctx = createTestContext({ webhookSender });
    ctx.configRepository.save({ webhookUrl: 'https://hooks.example.com/global-agent' });

    const agent = ctx.service.createAgent({ repoId: testRepo.repoId, prompt: 'Refactor auth' });
    ctx.repository.update(agent.agentId, {
      status: 'failed_machine',
      pushed: true,
      finishedAt: new Date().toISOString(),
      verification: {
        state: 'machine_failure',
        configSource: 'base',
        maxRepairAttempts: 2,
        draftPrOnFailure: false,
        attempts: [],
      },
    });
    ctx.spawned[0].emitExit(1);

    assert.equal(deliveries.length, 1);
    assert.equal((deliveries[0].data as { event: string }).event, 'agent.failed');
  });

  it('opens the draft PR for a needs_attention run only when draftPrOnFailure is set', async () => {
    let created = false;
    const ctx = createTestContext({ onCreatePullRequest: () => { created = true; } });

    const agent = ctx.service.createAgent({ repoId: testRepo.repoId, prompt: 'Refactor auth' });
    ctx.repository.update(agent.agentId, {
      status: 'needs_attention',
      pushed: true,
      finishedAt: new Date().toISOString(),
      verification: {
        state: 'failed',
        configSource: 'base',
        maxRepairAttempts: 2,
        draftPrOnFailure: true,
        attempts: [],
      },
    });
    ctx.spawned[0].emitExit(1);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(created, true);
  });
});
