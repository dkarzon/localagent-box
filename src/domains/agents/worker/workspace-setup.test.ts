import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { describe, it } from 'node:test';
import os from 'os';
import {
  initCodegraph,
  ensureLocalagentBoxIgnored,
  checkoutJobBranch,
  prepareWorkspace,
} from './workspace-setup';
import { createJsonStore } from '../../../lib/json-store';
import { resetServerEnvCache } from '../../../config/env';
import type { GitService } from '../../../services/git-service';
import type { GithubAppService } from '../../../services/github-app';
import type { Agent, AgentJob, AppConfig, Repo } from '../../../types';
import type { JsonStore } from '../../../lib/json-store';
import type { WorkerContext } from './worker-context';

const BASE_CONFIG: AppConfig = {
  ollamaBaseUrl: '',
  opencodeModel: '',
  opencodeProvider: 'ollama',
  systemPrompt: '',
  githubAppId: '',
  githubAppInstallationId: '',
  githubAppPrivateKey: '',
  gitUserName: '',
  gitUserEmail: '',
  webhookUrl: '',
  batchAutoApprovePermissions: true,
  loopAutoApprovePermissions: true,
  interactiveAutoApprovePermissions: false,
  reviewModel: '',
  interactiveAgentTimeoutSeconds: 3600,
  loopAgentTimeoutSeconds: 3600,
  loopVerbModels: { INITIAL_PLAN: '', ORIENT: '', ACT: '', REFLECT: '' },
};

function makeAgent(): Agent {
  return {
    agentId: 'agent1',
    workspaceId: 'ws1',
    repoId: 'acme-demo',
    mode: 'batch',
    prompt: 'goal',
    systemPrompt: null,
    baseBranch: 'main',
    agentBranch: 'main',
    commitMessage: 'test',
    push: false,
    pushOnFailure: false,
    model: null,
    status: 'queued',
    commitSha: null,
    pushed: false,
    filesChanged: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    branch: null,
    error: null,
    result: null,
  };
}

function makeJob(dataDir: string): AgentJob {
  const job: AgentJob = {
    agentId: 'agent1',
    workspaceId: 'ws1',
    repoId: 'acme-demo',
    mode: 'batch',
    prompt: 'goal',
    systemPrompt: '',
    baseBranch: 'main',
    agentBranch: 'main',
    commitMessage: 'test',
    push: false,
    pushOnFailure: false,
    agentTimeoutMs: 3600000,
    dataDir,
    workspaceRoot: dataDir,
    workspaceDir: path.join(dataDir, 'workspaces', 'agent1'),
    logPath: path.join(dataDir, 'agents', 'agent1', 'worker.log'),
  };
  fs.mkdirSync(path.dirname(job.logPath), { recursive: true });
  return job;
}

interface Harness {
  dataDir: string;
  /** Files here end up in the workspace after the stubbed clone. */
  fixtureDir: string;
  job: AgentJob;
  agentsStore: JsonStore<{ agents: Agent[] }>;
  reposStore: JsonStore<{ repos: Repo[] }>;
  buildContext: () => WorkerContext;
}

function makeRepo(): Repo {
  return {
    repoId: 'acme-demo',
    owner: 'acme',
    name: 'demo',
    defaultBranch: 'main',
    cloneUrl: 'https://github.com/acme/demo',
    registeredAt: '2025-01-01T00:00:00.000Z',
    lastVerifiedAt: null,
    lastVerifyStatus: null,
    lastVerifyMessage: null,
    autoReviewPullRequests: null,
  };
}

function makeHarness(): Harness {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-workspace-bootstrap-'));
  const fixtureDir = path.join(dataDir, 'fixture');
  fs.mkdirSync(fixtureDir, { recursive: true });

  const job = makeJob(dataDir);
  const agentsStore = createJsonStore<{ agents: Agent[] }>(
    path.join(dataDir, 'agents.json'),
    { agents: [makeAgent()] },
    fs,
  );
  const repo = makeRepo();
  const reposStore = createJsonStore<{ repos: Repo[] }>(
    path.join(dataDir, 'repos.json'),
    { repos: [repo] },
    fs,
  );
  reposStore.save({ repos: [repo] });

  const githubApp = {
    getInstallationToken: async () => 'clone-token',
  } as unknown as GithubAppService;

  const gitService = {
    shallowClone: async ({ targetDir }: { targetDir: string }) => {
      fs.mkdirSync(targetDir, { recursive: true });
      fs.cpSync(fixtureDir, targetDir, { recursive: true });
    },
    remoteBranchExists: async () => false,
  } as unknown as GitService;

  return {
    dataDir,
    fixtureDir,
    job,
    agentsStore,
    reposStore: reposStore,
    buildContext: () =>
      ({
        job,
        logPath: job.logPath,
        config: BASE_CONFIG,
        agentsStore,
        githubApp,
        gitService,
      }) as WorkerContext,
  };
}

function writeEnvironmentJson(h: Harness, content: string): void {
  const envDir = path.join(h.fixtureDir, '.localagent-box');
  fs.mkdirSync(envDir, { recursive: true });
  fs.writeFileSync(path.join(envDir, 'environment.json'), content, 'utf8');
}

describe('prepareWorkspace — bootstrap wiring', () => {
  function withNoCodegraph(fn: () => Promise<void>): Promise<void> {
    const original = process.env.ENABLE_CODEGRAPH;
    process.env.ENABLE_CODEGRAPH = 'false';
    resetServerEnvCache();
    return fn().finally(() => {
      if (original === undefined) {
        delete process.env.ENABLE_CODEGRAPH;
      } else {
        process.env.ENABLE_CODEGRAPH = original;
      }
      resetServerEnvCache();
    });
  }

  it('runs the configured setup command during workspace prep and records it on the agent', async () => {
    const h = makeHarness();
    fs.writeFileSync(path.join(h.fixtureDir, 'package.json'), '{}', 'utf8');
    writeEnvironmentJson(h, JSON.stringify({ version: 1, setup: { command: 'echo bootstrap-ok' } }));

    try {
      await withNoCodegraph(() => prepareWorkspace(h.buildContext()));

      const agent = h.agentsStore.load().agents[0];
      assert.equal(agent.bootstrap?.status, 'completed');
      assert.equal(agent.bootstrap?.command, 'echo bootstrap-ok');
      assert.equal(agent.bootstrap?.exitCode, 0);
      assert.match(agent.bootstrap?.outputTail ?? '', /bootstrap-ok/);

      const log = fs.readFileSync(h.job.logPath, 'utf8');
      assert.match(log, /Running workspace bootstrap/);
    } finally {
      fs.rmSync(h.dataDir, { recursive: true, force: true });
    }
  });

  it('propagates a failing bootstrap so the worker never reaches OpenCode', async () => {
    const h = makeHarness();
    fs.writeFileSync(path.join(h.fixtureDir, 'package.json'), '{}', 'utf8');
    writeEnvironmentJson(h, JSON.stringify({ version: 1, setup: { command: 'exit 1' } }));

    let caught: unknown;
    try {
      try {
        await withNoCodegraph(async () => {
          await prepareWorkspace(h.buildContext());
        });
        const agent = h.agentsStore.load().agents[0];
        assert.equal(agent.bootstrap?.status, 'failed');
        assert.equal(agent.bootstrap?.exitCode, 1);
        const log = fs.readFileSync(h.job.logPath, 'utf8');
        assert.match(log, /Running workspace bootstrap/);
        assert.match(log, /Workspace bootstrap failed with exit code 1/);
      } catch (err) {
        caught = err;
      }
    } finally {
      fs.rmSync(h.dataDir, { recursive: true, force: true });
    }

    assert.ok(caught instanceof Error);
    assert.match((caught as Error).message, /Bootstrap failed: `exit 1` exited 1/);
  });

  it('skips bootstrap when the repo has no environment.json', async () => {
    const h = makeHarness();
    fs.writeFileSync(path.join(h.fixtureDir, 'package.json'), '{}', 'utf8');

    try {
      await withNoCodegraph(async () => {
        await prepareWorkspace(h.buildContext());
      });

      const agent = h.agentsStore.load().agents[0];
      assert.equal(agent.bootstrap, undefined);

      const log = fs.readFileSync(h.job.logPath, 'utf8');
      assert.doesNotMatch(log, /Running workspace bootstrap/);
    } finally {
      fs.rmSync(h.dataDir, { recursive: true, force: true });
    }
  });
});

describe('ensureLocalagentBoxIgnored', () => {
  const base = path.join(os.tmpdir(), 'test-gitignore-');

  it('creates .gitignore when it does not exist', () => {
    const dir = fs.mkdtempSync(base);
    try {
      ensureLocalagentBoxIgnored(dir);
      const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
      assert.equal(content, '.localagent-box/loop-plan.md\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('appends entry when .gitignore exists without the entry', () => {
    const dir = fs.mkdtempSync(base);
    try {
      fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n', 'utf8');
      ensureLocalagentBoxIgnored(dir);
      const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
      assert.equal(content, 'node_modules/\n.localagent-box/loop-plan.md\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does nothing when entry already present', () => {
    const dir = fs.mkdtempSync(base);
    try {
      fs.writeFileSync(path.join(dir, '.gitignore'), '.localagent-box/loop-plan.md\nnode_modules/\n', 'utf8');
      ensureLocalagentBoxIgnored(dir);
      const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
      assert.equal(content, '.localagent-box/loop-plan.md\nnode_modules/\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles .gitignore not ending with newline', () => {
    const dir = fs.mkdtempSync(base);
    try {
      fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/', 'utf8');
      ensureLocalagentBoxIgnored(dir);
      const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
      assert.equal(content, 'node_modules/\n.localagent-box/loop-plan.md\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('initCodegraph', () => {
  function makeLogPath(): { dir: string; logPath: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-codegraph-'));
    return { dir, logPath: path.join(dir, 'agent.log') };
  }

  it('runs `codegraph init` in the workspace and reports success', async () => {
    const { dir, logPath } = makeLogPath();
    try {
      const calls: { file: string; args: string[]; cwd?: string }[] = [];
      const execStub = (async (file: string, args: string[], opts: { cwd?: string }) => {
        calls.push({ file, args, cwd: opts.cwd });
        return { stdout: '', stderr: '' };
      }) as never;

      const ok = await initCodegraph('/workspace/agents/abc', logPath, execStub);

      assert.equal(ok, true);
      assert.deepEqual(calls, [
        { file: 'codegraph', args: ['init'], cwd: '/workspace/agents/abc' },
      ]);
      assert.match(fs.readFileSync(logPath, 'utf8'), /codegraph index built/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is non-fatal when init fails', async () => {
    const { dir, logPath } = makeLogPath();
    try {
      const execStub = (async () => {
        throw new Error('binary not found');
      }) as never;

      const ok = await initCodegraph('/workspace/agents/abc', logPath, execStub);

      assert.equal(ok, false);
      assert.match(
        fs.readFileSync(logPath, 'utf8'),
        /codegraph init failed.*binary not found/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('checkoutJobBranch', () => {
  function makeLogPath(): { dir: string; logPath: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-checkout-'));
    return { dir, logPath: path.join(dir, 'agent.log') };
  }

  function stubGit(remoteExists: boolean) {
    const created: string[] = [];
    const fetched: Array<{ branch: string; shallow?: boolean }> = [];
    return {
      created,
      fetched,
      gitService: {
        remoteBranchExists: async () => remoteExists,
        fetchAndCheckoutBranch: async (
          _dir: string,
          branch: string,
          options?: { shallow?: boolean },
        ) => {
          fetched.push({ branch, shallow: options?.shallow });
        },
        createBranch: async (_dir: string, branch: string) => {
          created.push(branch);
        },
      },
    };
  }

  it('stays on the cloned branch when agentBranch equals baseBranch', async () => {
    const { dir, logPath } = makeLogPath();
    try {
      const stub = stubGit(true);
      const result = await checkoutJobBranch(
        stub.gitService,
        { workspaceDir: '/ws', baseBranch: 'main', agentBranch: 'main' },
        { shallow: true, logPath },
      );
      assert.equal(result, 'cloned');
      assert.deepEqual(stub.created, []);
      assert.deepEqual(stub.fetched, []);
      assert.match(fs.readFileSync(logPath, 'utf8'), /Checked out existing branch main/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fetches the agent branch when it exists on origin', async () => {
    const { dir, logPath } = makeLogPath();
    try {
      const stub = stubGit(true);
      const result = await checkoutJobBranch(
        stub.gitService,
        { workspaceDir: '/ws', baseBranch: 'main', agentBranch: 'feature/project' },
        { shallow: true, logPath },
      );
      assert.equal(result, 'fetched');
      assert.deepEqual(stub.created, []);
      assert.deepEqual(stub.fetched, [{ branch: 'feature/project', shallow: true }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates the agent branch from base when origin does not have it', async () => {
    const { dir, logPath } = makeLogPath();
    try {
      const stub = stubGit(false);
      const result = await checkoutJobBranch(
        stub.gitService,
        { workspaceDir: '/ws', baseBranch: 'main', agentBranch: 'feature/project' },
        { shallow: true, logPath },
      );
      assert.equal(result, 'created');
      assert.deepEqual(stub.created, ['feature/project']);
      assert.deepEqual(stub.fetched, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
