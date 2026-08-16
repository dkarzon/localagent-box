import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import { createJsonStore } from '../../lib/json-store';
import { buildLoopState } from '../../lib/loop-state';
import { CodedError, type Agent, type Repo } from '../../types';
import type { GithubAppService } from '../../services/github-app';
import type { GitService } from '../../services/git-service';
import type { OllamaChatService } from '../../services/ollama-client';
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
  return child as ChildProcess & { emitExit: (code?: number | null, signal?: NodeJS.Signals | null) => void };
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
    loopAutoApprovePermissions: true,
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

  const repoManager = {
    getRepo: (repoId: string) => {
      if (repoId !== testRepo.repoId) {
        throw new Error(`Unknown repo: ${repoId}`);
      }
      return testRepo;
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
    createPullRequestReview: async () => ({ id: '1', html_url: 'https://example.com/review/1' }),
    redactSecrets: (text) => text,
    createAppJwt: () => '',
    normalizePrivateKey: (key) => key,
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
    getPorcelainStatus: async () => ' M src/changed.ts',
    getDiffStat: async () => ' src/changed.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)',
    parsePorcelainStatus: () => [{ path: 'src/changed.ts', kind: 'modified', statusCode: ' M' }],
    countChangedFiles: () => 1,
    commitAll: async () => 'deadbeef1234567890',
    pushBranch: async () => {},
    getCommitDiff: async () => null,
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

describe('createAgentService (loop mode)', () => {
  it('creates a loop agent with initial loop state and queues it', () => {
    const { service } = createTestContext();

    const agent = service.createAgent({
      repoId: testRepo.repoId,
      prompt: 'Refactor auth module',
      mode: 'loop',
      pushOnFailure: true,
    });

    assert.equal(agent.mode, 'loop');
    assert.equal(agent.status, 'queued');
    assert.equal(agent.pushOnFailure, true);
    assert.ok(agent.loop);
    assert.equal(agent.loop!.iteration, 1);
    assert.equal(agent.loop!.finishRequested, false);
    assert.equal(agent.loop!.canFinish, false);
  });

  it('returns derived loop fields when fetching an active loop agent', () => {
    const { service, repository } = createTestContext();
    const agentId = 'loopproc0001';
    seedAgent(
      repository,
      baseAgentFields({
        agentId,
        mode: 'loop',
        status: 'processing',
        loop: buildLoopState('processing'),
      }),
    );

    const agent = service.getAgent(agentId);

    assert.equal(agent.mode, 'loop');
    assert.ok(agent.loop);
    assert.equal(agent.loop!.canFinish, true);
    assert.equal(agent.loop!.finishRequested, false);
  });
});

describe('finishAgent', () => {
  it('sets finishRequested on loop agents without moving to completing', () => {
    const { service, repository } = createTestContext();
    const agentId = 'loopfinish01';
    seedAgent(
      repository,
      baseAgentFields({
        agentId,
        mode: 'loop',
        status: 'processing',
        loop: buildLoopState('processing'),
      }),
    );

    const updated = service.finishAgent(agentId);

    assert.equal(updated.status, 'processing');
    assert.ok(updated.loop);
    assert.equal(updated.loop!.finishRequested, true);

    const inbox = fs
      .readFileSync(repository.getInboxPath(agentId), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string });
    assert.equal(inbox.at(-1)?.type, 'finish');
  });

  it('moves interactive agents to completing', () => {
    const { service, repository } = createTestContext();
    const agentId = 'intfinish001';
    seedAgent(
      repository,
      baseAgentFields({
        agentId,
        mode: 'interactive',
        status: 'awaiting_input',
        opencodeSessionId: 'sess-1',
        turnCount: 1,
      }),
    );

    const updated = service.finishAgent(agentId);

    assert.equal(updated.status, 'completing');
    assert.equal(updated.mode, 'interactive');
  });

  it('rejects batch agents with NOT_INTERACTIVE', () => {
    const { service, repository } = createTestContext();
    const agentId = 'batchfinish1';
    seedAgent(
      repository,
      baseAgentFields({
        agentId,
        mode: 'batch',
        status: 'processing',
      }),
    );

    assert.throws(
      () => service.finishAgent(agentId),
      (err: unknown) => err instanceof CodedError && err.code === 'NOT_INTERACTIVE',
    );
  });

  it('rejects terminal loop agents with NOT_ACTIVE', () => {
    const { service, repository } = createTestContext();
    const agentId = 'loopdone0001';
    seedAgent(
      repository,
      baseAgentFields({
        agentId,
        mode: 'loop',
        status: 'completed',
        finishedAt: '2026-06-09T01:00:00.000Z',
        loop: buildLoopState('completed'),
      }),
    );

    assert.throws(
      () => service.finishAgent(agentId),
      (err: unknown) => err instanceof CodedError && err.code === 'NOT_ACTIVE',
    );
  });
});

describe('sendMessage', () => {
  it('rejects loop agents with NOT_INTERACTIVE', () => {
    const { service, repository } = createTestContext();
    const agentId = 'loopmsg00001';
    seedAgent(
      repository,
      baseAgentFields({
        agentId,
        mode: 'loop',
        status: 'processing',
        loop: buildLoopState('processing'),
      }),
    );

    assert.throws(
      () => service.sendMessage(agentId, 'Hello'),
      (err: unknown) => err instanceof CodedError && err.code === 'NOT_INTERACTIVE',
    );
  });
});

describe('commitOutstandingChanges', () => {
  it('commits and completes a failed loop session with outstanding changes', async () => {
    const { service, repository, workspaceRoot } = createTestContext();
    const agentId = 'loopcommit01';
    const workspaceId = 'ws-loop-commit';
    const workspaceDir = repository.getWorkspaceDir(workspaceId);
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'README.md'), 'loop changes', 'utf8');

    seedAgent(
      repository,
      baseAgentFields({
        agentId,
        workspaceId,
        mode: 'loop',
        status: 'failed',
        finishedAt: '2026-06-09T01:00:00.000Z',
        error: 'Loop reached max iterations (5) without completion signal',
        loop: buildLoopState('failed', { iteration: 5 }, {
          status: 'failed',
          commitSha: null,
          gitStatus: {
            filesChanged: 1,
            files: [{ path: 'README.md', kind: 'modified', statusCode: ' M' }],
            updatedAt: '2026-06-09T01:00:00.000Z',
          },
        }),
        gitStatus: {
          filesChanged: 1,
          files: [{ path: 'README.md', kind: 'modified', statusCode: ' M' }],
          updatedAt: '2026-06-09T01:00:00.000Z',
        },
      }),
    );

    const updated = await service.commitOutstandingChanges(agentId);

    assert.equal(updated.status, 'completed');
    assert.equal(updated.commitSha, 'deadbeef1234567890');
    assert.equal(updated.pushed, true);
    assert.equal(updated.filesChanged, 1);
    assert.equal(updated.error, null);
    assert.ok(updated.result?.warning?.includes('committed manually'));
    assert.equal(updated.loop?.canCommitOutstanding, false);
    assert.equal(fs.readFileSync(repository.getLogPath(agentId), 'utf8').includes('Outstanding changes committed'), true);
    assert.equal(fs.existsSync(workspaceDir), true);
    assert.equal(workspaceRoot, path.dirname(workspaceDir));
  });

  it('does not auto-create a pull request when committing outstanding changes', async () => {
    let createPrCalls = 0;
    const { service, repository } = createTestContext({
      onCreatePullRequest: () => {
        createPrCalls += 1;
      },
    });
    const agentId = 'loopcommit02';
    const workspaceId = 'ws-loop-commit-2';
    const workspaceDir = repository.getWorkspaceDir(workspaceId);
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'README.md'), 'loop changes', 'utf8');

    seedAgent(
      repository,
      baseAgentFields({
        agentId,
        workspaceId,
        mode: 'loop',
        status: 'failed',
        autoCreatePullRequest: true,
        finishedAt: '2026-06-09T01:00:00.000Z',
        error: 'Loop reached max iterations (5) without completion signal',
        loop: buildLoopState('failed', { iteration: 5 }, {
          status: 'failed',
          commitSha: null,
          gitStatus: {
            filesChanged: 1,
            files: [{ path: 'README.md', kind: 'modified', statusCode: ' M' }],
            updatedAt: '2026-06-09T01:00:00.000Z',
          },
        }),
        gitStatus: {
          filesChanged: 1,
          files: [{ path: 'README.md', kind: 'modified', statusCode: ' M' }],
          updatedAt: '2026-06-09T01:00:00.000Z',
        },
      }),
    );

    const updated = await service.commitOutstandingChanges(agentId);
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(updated.pushed, true);
    assert.equal(updated.pullRequest, null);
    assert.equal(createPrCalls, 0);
  });

  it('rejects non-loop agents', async () => {
    const { service, repository } = createTestContext();
    const agentId = 'batchcommit1';
    seedAgent(
      repository,
      baseAgentFields({
        agentId,
        mode: 'batch',
        status: 'failed',
        finishedAt: '2026-06-09T01:00:00.000Z',
      }),
    );

    await assert.rejects(
      () => service.commitOutstandingChanges(agentId),
      (err: unknown) => err instanceof CodedError && err.code === 'NOT_LOOP',
    );
  });

  it('rejects failed loop sessions without outstanding changes', async () => {
    const { service, repository } = createTestContext();
    const agentId = 'loopnocommit1';
    seedAgent(
      repository,
      baseAgentFields({
        agentId,
        mode: 'loop',
        status: 'failed',
        finishedAt: '2026-06-09T01:00:00.000Z',
        loop: buildLoopState('failed'),
        gitStatus: {
          filesChanged: 0,
          files: [],
          updatedAt: '2026-06-09T01:00:00.000Z',
        },
      }),
    );

    await assert.rejects(
      () => service.commitOutstandingChanges(agentId),
      (err: unknown) => err instanceof CodedError && err.code === 'NO_CHANGES',
    );
  });
});

describe('cancelAgent', () => {
  it('cancels an active loop agent without committing', () => {
    const { service, repository } = createTestContext();
    const agentId = 'loopcancel01';
    seedAgent(
      repository,
      baseAgentFields({
        agentId,
        mode: 'loop',
        status: 'processing',
        loop: buildLoopState('processing'),
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
  it('re-enqueues queued agents and starts the first eligible one', () => {
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

    ctx.service.restoreOnStartup();

    assert.equal(ctx.service.getAgent('queued0000001').status, 'queued');
    assert.equal(hasStartedWorker(ctx, 'queued0000001'), true);
  });

  it('fails in-progress agents but keeps later queued chunks waiting', () => {
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

    ctx.service.restoreOnStartup();

    const failed = ctx.service.getAgent('running000001');
    assert.equal(failed.status, 'failed');
    assert.match(failed.error || '', /Server restarted/);
    assert.equal(ctx.service.getAgent('queued0000002').status, 'queued');
    assert.equal(hasStartedWorker(ctx, 'queued0000002'), false);
  });

  it('starts queued sessions in createdAt order across branches', () => {
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

    ctx.service.restoreOnStartup();

    assert.equal(hasStartedWorker(ctx, 'queued-b'), true);
    assert.equal(hasStartedWorker(ctx, 'queued-a'), true);
  });
});

