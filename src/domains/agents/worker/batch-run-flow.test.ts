import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { OpenCodeSessionRunner } from '../../../integrations/opencode/session-runner';
import type { GithubAppService } from '../../../services/github-app';
import type { GitService } from '../../../services/git-service';
import { createJsonStore, type JsonStore } from '../../../lib/json-store';
import { NO_CHANGE_ARTEFACT_PATH } from '../../../lib/schemas/no-change';
import type {
  Agent,
  AgentCheckRun,
  AgentJob,
  AgentVerification,
  AgentVerificationAttempt,
  AppConfig,
  Repo,
  RepoEnvironmentConfig,
} from '../../../types';
import type { WorkerContext } from './worker-context';
import {
  resolveAutoApprovePermissions,
  resolveBatchCompletionStatus,
  resolveBatchFailureMessage,
  runBatchJob,
} from './batch-run-flow';
import { runChecks, type RunChecksDeps, type ResolvedCheck } from './verification';

const baseConfig: AppConfig = {
  ollamaBaseUrl: '',
  ollamaCloudApiKey: '',
  ollamaCloudBaseUrl: '',
  openaiCompatibleBaseUrl: '',
  openaiCompatibleApiKey: '',
  opencodeModel: '',
  opencodeProvider: 'ollama',
  reviewProvider: '',
  systemPrompt: '',
  githubAppId: '',
  githubAppInstallationId: '',
  githubAppPrivateKey: '',
  gitUserName: '',
  gitUserEmail: '',
  webhookUrl: '',
  batchAutoApprovePermissions: true,
  reviewModel: '',
};

const baseJob: AgentJob = {
  agentId: 'agent1',
  workspaceId: 'ws1',
  repoId: 'acme-demo',
  prompt: 'goal',
  baseBranch: 'main',
  agentBranch: 'localagent-agent1',
  checksBaseBranch: 'main',
  commitMessage: 'test',
  push: true,
  pushOnFailure: false,
  agentTimeoutMs: 3600000,
  dataDir: '/data',
  workspaceRoot: '/workspaces',
  workspaceDir: '/workspaces/ws1',
  logPath: '/data/agents/agent1/worker.log',
};

describe('resolveAutoApprovePermissions', () => {
  it('uses batchAutoApprovePermissions for batch mode', () => {
    const config = { ...baseConfig, batchAutoApprovePermissions: false };
    assert.equal(resolveAutoApprovePermissions(config, baseJob), false);
  });

  it('defaults batch auto-approve to true when the setting is unset', () => {
    const config = { ...baseConfig, batchAutoApprovePermissions: undefined as unknown as boolean };
    assert.equal(resolveAutoApprovePermissions(config, baseJob), true);
  });

  it('prefers the per-agent override', () => {
    const job = { ...baseJob, autoApprovePermissions: false };
    assert.equal(resolveAutoApprovePermissions(baseConfig, job), false);
  });
});

describe('resolveBatchCompletionStatus', () => {
  it('completes when checks pass or none are configured', () => {
    const passed: AgentVerification = {
      state: 'passed',
      configSource: 'base',
      maxRepairAttempts: 2,
      attempts: [{ attempt: 0, startedAt: '', finishedAt: '', checks: [], passed: true }],
    };
    assert.equal(
      resolveBatchCompletionStatus({
        opencodeSuccess: true,
        pushOnFailure: false,
        filesChanged: 2,
        verification: passed,
      }),
      'completed',
    );

    const unverified: AgentVerification = {
      state: 'unverified',
      configSource: 'none',
      maxRepairAttempts: 2,
      attempts: [],
    };
    assert.equal(
      resolveBatchCompletionStatus({
        opencodeSuccess: true,
        pushOnFailure: false,
        filesChanged: 1,
        verification: unverified,
      }),
      'completed',
    );
  });

  it('reports a code failure as needing attention, even with changes', () => {
    const failed: AgentVerification = {
      state: 'failed',
      configSource: 'base',
      maxRepairAttempts: 2,
      attempts: [
        {
          attempt: 0,
          startedAt: '',
          finishedAt: '',
          checks: [
            {
              name: 'test',
              command: 'npm test',
              exitCode: 1,
              signal: null,
              timedOut: false,
              durationMs: 100,
              outputTail: '1 failed',
            },
          ],
          passed: false,
          failureKind: 'code',
        },
      ],
    };
    assert.equal(
      resolveBatchCompletionStatus({
        opencodeSuccess: true,
        pushOnFailure: false,
        filesChanged: 3,
        verification: failed,
      }),
      'needs_attention',
    );
  });

  it('reports a machine failure as its own status', () => {
    const machine: AgentVerification = {
      state: 'machine_failure',
      configSource: 'base',
      maxRepairAttempts: 2,
      attempts: [
        {
          attempt: 0,
          startedAt: '',
          finishedAt: '',
          checks: [
            {
              name: 'build',
              command: 'npm run build',
              exitCode: 137,
              signal: 'SIGKILL',
              timedOut: false,
              durationMs: 100,
              outputTail: 'Killed',
            },
          ],
          passed: false,
          failureKind: 'machine',
          machineReason: 'oom',
        },
      ],
    };
    assert.equal(
      resolveBatchCompletionStatus({
        opencodeSuccess: true,
        pushOnFailure: false,
        filesChanged: 1,
        verification: machine,
      }),
      'failed_machine',
    );
  });

  it('keeps the no-change failure when checks are not the problem', () => {
    assert.equal(
      resolveBatchCompletionStatus({
        opencodeSuccess: true,
        pushOnFailure: false,
        filesChanged: 0,
        verification: {
          state: 'unverified',
          configSource: 'none',
          maxRepairAttempts: 2,
          attempts: [],
        },
      }),
      'failed',
    );
  });
});

describe('resolveBatchFailureMessage', () => {
  it('names the failing check and its exit code', () => {
    const verification: AgentVerification = {
      state: 'failed',
      configSource: 'base',
      maxRepairAttempts: 2,
      attempts: [
        {
          attempt: 0,
          startedAt: '',
          finishedAt: '',
          checks: [
            {
              name: 'lint',
              command: 'npm run lint',
              exitCode: 1,
              signal: null,
              timedOut: false,
              durationMs: 50,
              outputTail: '',
            },
            {
              name: 'test',
              command: 'npm test',
              exitCode: 7,
              signal: null,
              timedOut: false,
              durationMs: 50,
              outputTail: '',
            },
          ],
          passed: false,
          failureKind: 'code',
        },
      ],
    };
    assert.equal(
      resolveBatchFailureMessage({
        opencodeSuccess: true,
        pushOnFailure: false,
        filesChanged: 1,
        verification,
      }),
      'Checks failed: test exit 7',
    );
  });

  it('names the machine reason and the check', () => {
    const verification: AgentVerification = {
      state: 'machine_failure',
      configSource: 'base',
      maxRepairAttempts: 2,
      attempts: [
        {
          attempt: 0,
          startedAt: '',
          finishedAt: '',
          checks: [
            {
              name: 'build',
              command: 'npm run build',
              exitCode: 124,
              signal: null,
              timedOut: true,
              durationMs: 600000,
              outputTail: '',
            },
          ],
          passed: false,
          failureKind: 'machine',
          machineReason: 'timeout',
        },
      ],
    };
    assert.equal(
      resolveBatchFailureMessage({
        opencodeSuccess: true,
        pushOnFailure: false,
        filesChanged: 1,
        verification,
      }),
      'Machine failure: timeout in build',
    );
  });

  it('counts the repair attempts that did not fix the check', () => {
    const verification: AgentVerification = {
      state: 'failed',
      configSource: 'base',
      maxRepairAttempts: 2,
      attempts: [
        {
          attempt: 2,
          startedAt: '',
          finishedAt: '',
          checks: [
            {
              name: 'test',
              command: 'npm test',
              exitCode: 1,
              signal: null,
              timedOut: false,
              durationMs: 50,
              outputTail: '1 failed',
            },
          ],
          passed: false,
          failureKind: 'code',
        },
      ],
    };
    assert.equal(
      resolveBatchFailureMessage({
        opencodeSuccess: true,
        pushOnFailure: false,
        filesChanged: 1,
        verification,
      }),
      'Checks failed: test exit 1 after 2 repair attempt(s)',
    );
  });

  it('keeps the existing messages when checks are not the cause', () => {
    assert.equal(
      resolveBatchFailureMessage({
        opencodeSuccess: true,
        pushOnFailure: false,
        filesChanged: 0,
        verification: {
          state: 'unverified',
          configSource: 'none',
          maxRepairAttempts: 2,
          attempts: [],
        },
      }),
      'Batch run finished without file changes — the model may have returned an overview only',
    );
  });
});

interface CheckCall {
  attempt: number;
  /** Status the record held while the host ran the checks. */
  status: string;
  /** Repair decision already recorded when this attempt ran. */
  repairAttempt: number | undefined;
}

function checkRun(overrides: Partial<AgentCheckRun> = {}): AgentCheckRun {
  return {
    name: 'test',
    command: 'npm test',
    exitCode: 1,
    signal: null,
    timedOut: false,
    durationMs: 120,
    outputTail: '1 test failed',
    ...overrides,
  };
}

function attemptResult(
  index: number,
  run: AgentCheckRun | null,
  failure?: { kind: 'code' | 'machine'; reason?: string },
): AgentVerificationAttempt {
  return {
    attempt: index,
    startedAt: '2026-11-26T00:00:00.000Z',
    finishedAt: '2026-11-26T00:00:05.000Z',
    checks: run ? [run] : [],
    passed: run === null,
    ...(run && failure
      ? { failureKind: failure.kind, ...(failure.reason ? { machineReason: failure.reason } : {}) }
      : {}),
  };
}

/** Fake host runner: one scripted outcome per call, plus the record held at call time. */
function makeRunChecks(
  outcomes: AgentVerificationAttempt[],
  calls: CheckCall[],
  readRecord: () => Agent,
): typeof runChecks {
  return (async (
    _workspaceDir: string,
    _checks: readonly ResolvedCheck[],
    deps: RunChecksDeps,
  ): Promise<AgentVerificationAttempt> => {
    const record = readRecord();
    calls.push({ attempt: deps.attempt, status: record.status, repairAttempt: record.repairAttempt });
    return outcomes[deps.attempt];
  }) as typeof runChecks;
}

/** Fake session runner: each turn goes busy then idle, so the host sees it complete. */
function makeFakeRunner(polls: Array<Record<string, { type?: string }>>) {
  const prompts: string[] = [];
  const queue = [...polls];
  const sessionId = 'ses_fake';
  const runner: OpenCodeSessionRunner = {
    port: 0,
    baseUrl: 'http://127.0.0.1:0',
    startServer: async () => {},
    waitForServerReady: async () => {},
    createSession: async () => ({ id: sessionId }),
    sendPromptAsync: async (_sessionId, body) => {
      prompts.push(body.parts.map((part) => part.text).join('\n\n'));
    },
    replyPermission: async () => {},
    cancelForm: async () => {},
    getSessionStatusMap: async () => queue.shift() ?? {},
    abort: async () => {},
    subscribeEvents: () => ({ unsubscribe: () => {}, ready: Promise.resolve() }),
    dispose: async () => {},
  };
  return { runner, prompts };
}

const runConfig: AppConfig = { ...baseConfig, opencodeModel: 'qwen3' };

const checkConfig: RepoEnvironmentConfig = {
  version: 1,
  checks: { test: 'npm test' },
  repairAttempts: 2,
};

function makeBatchHarness(porcelainOutputs: string[] = [' M src/changed.ts']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-run-'));
  const dataDir = path.join(root, 'data');
  const agentDir = path.join(dataDir, 'agents', 'agent1');
  const workspaceDir = path.join(root, 'workspace');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });

  const job: AgentJob = {
    agentId: 'agent1',
    workspaceId: 'ws1',
    repoId: 'acme-demo',
    mode: 'batch',
    prompt: 'Fix the failing test',
    baseBranch: 'main',
    agentBranch: 'localagent-agent1',
    checksBaseBranch: 'main',
    commitMessage: 'test',
    push: true,
    pushOnFailure: false,
    agentTimeoutMs: 60_000,
    dataDir,
    workspaceRoot: root,
    workspaceDir,
    logPath: path.join(agentDir, 'worker.log'),
  };

  const agentsStore: JsonStore<{ agents: Agent[] }> = createJsonStore<{ agents: Agent[] }>(
    path.join(dataDir, 'agents.json'),
    {
      agents: [
        {
          agentId: job.agentId,
          workspaceId: job.workspaceId,
          repoId: job.repoId,
          mode: 'batch',
          prompt: job.prompt,
          systemPrompt: null,
          baseBranch: job.baseBranch,
          agentBranch: job.agentBranch,
          commitMessage: job.commitMessage,
          push: job.push,
          pushOnFailure: job.pushOnFailure,
          model: null,
          status: 'running',
          turnCount: 0,
          commitSha: null,
          pushed: false,
          filesChanged: null,
          createdAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          finishedAt: null,
          branch: job.agentBranch,
          error: null,
          result: null,
        } as Agent,
      ],
    },
    fs,
  );

  const gitService = {
    ensureRemoteRef: async () => ({ available: true, fetched: false }),
    // Scripted per call so the completion gate and the commit step see the same tree;
    // the last scripted state persists for later calls.
    getPorcelainStatus: async () =>
      porcelainOutputs.length > 1 ? porcelainOutputs.shift()! : porcelainOutputs[0] ?? '',
    countChangedFiles: (porcelain: string) => porcelain.split('\n').filter((line) => line.trim()).length,
    getCommitsSinceRunStart: async () => ({ commits: 0, filesChanged: 0 }),
    commitAll: async () => 'deadbeef1234567890',
    getHeadSha: async () => 'deadbeef1234567890',
    pushBranch: async () => {},
  } as unknown as GitService;

  const githubApp = { getInstallationToken: async () => 'token' } as unknown as GithubAppService;

  const ctx = {
    job,
    logPath: job.logPath,
    config: runConfig,
    agentsStore,
    repo: { repoId: job.repoId, owner: 'acme', name: 'demo', defaultBranch: 'main' } as Repo,
    gitService,
    githubApp,
  } as unknown as WorkerContext;

  const record = () => agentsStore.load().agents[0];
  return { ctx, job, record };
}

/** busy then idle per turn, so a run with `turns` turns needs `turns * 2` polls. */
function pollsForTurns(turns: number): Array<Record<string, { type?: string }>> {
  const polls: Array<Record<string, { type?: string }>> = [];
  for (let turn = 0; turn < turns; turn += 1) {
    polls.push({ ses_fake: { type: 'busy' } }, {});
  }
  return polls;
}

describe('runBatchJob repair loop', () => {
  it('repairs until the checks pass and completes with every attempt recorded', async () => {
    const { ctx, record } = makeBatchHarness();
    const calls: CheckCall[] = [];
    const { runner, prompts } = makeFakeRunner(pollsForTurns(3));

    await runBatchJob(ctx, {
      loadCheckConfig: async () => checkConfig,
      runChecks: makeRunChecks(
        [
          attemptResult(0, checkRun(), { kind: 'code' }),
          attemptResult(1, checkRun(), { kind: 'code' }),
          attemptResult(2, null),
        ],
        calls,
        record,
      ),
      createRunner: () => runner,
    });

    const agent = record();
    assert.equal(agent.status, 'completed');
    assert.equal(agent.verification?.state, 'passed');
    assert.equal(agent.verification?.attempts.length, 3);
    assert.deepEqual(
      agent.verification?.attempts.map((attempt) => attempt.attempt),
      [0, 1, 2],
    );
    assert.equal(agent.pushed, true);
    // Host checks run under `verifying`; each code failure records the repair turn.
    assert.deepEqual(calls.map((call) => call.status), ['verifying', 'verifying', 'verifying']);
    assert.deepEqual(calls.map((call) => call.repairAttempt), [undefined, 1, 2]);
    assert.equal(agent.repairAttempt, 2);
    assert.equal(prompts.length, 3);
    assert.match(prompts[1], /repair attempt 1 of 2/);
    assert.match(prompts[2], /repair attempt 2 of 2/);
  });

  it('reports needs_attention once the repair attempts are used up', async () => {
    const { ctx, record } = makeBatchHarness();
    const calls: CheckCall[] = [];
    const { runner, prompts } = makeFakeRunner(pollsForTurns(3));

    await assert.rejects(
      () =>
        runBatchJob(ctx, {
          loadCheckConfig: async () => checkConfig,
          runChecks: makeRunChecks(
            [
              attemptResult(0, checkRun(), { kind: 'code' }),
              attemptResult(1, checkRun(), { kind: 'code' }),
              attemptResult(2, checkRun(), { kind: 'code' }),
            ],
            calls,
            record,
          ),
          createRunner: () => runner,
        }),
      /Checks failed: test exit 1 after 2 repair attempt\(s\)/,
    );

    const agent = record();
    assert.equal(agent.status, 'needs_attention');
    assert.equal(agent.verification?.attempts.length, 3);
    assert.equal(agent.pushed, true, 'the branch is still pushed for a person to look at');
    assert.deepEqual(calls.map((call) => call.repairAttempt), [undefined, 1, 2]);
    assert.equal(prompts.length, 3, 'two repair turns, then the run stops');
  });

  it('stops immediately on a machine failure without a repair turn', async () => {
    const { ctx, record } = makeBatchHarness();
    const calls: CheckCall[] = [];
    const { runner, prompts } = makeFakeRunner(pollsForTurns(1));

    await assert.rejects(
      () =>
        runBatchJob(ctx, {
          loadCheckConfig: async () => checkConfig,
          runChecks: makeRunChecks(
            [
              attemptResult(
                0,
                checkRun({ exitCode: 124, timedOut: true, outputTail: '' }),
                { kind: 'machine', reason: 'timeout' },
              ),
            ],
            calls,
            record,
          ),
          createRunner: () => runner,
        }),
      /Machine failure: timeout in test/,
    );

    const agent = record();
    assert.equal(agent.status, 'failed_machine');
    assert.equal(agent.verification?.attempts.length, 1);
    assert.equal(agent.verification?.attempts[0]?.machineReason, 'timeout');
    assert.equal(agent.repairAttempt, undefined, 'a machine failure never earns a repair turn');
    assert.equal(prompts.length, 1, 'no follow-up was sent');
  });

  it('records no repair turn when the repo allows none', async () => {
    const { ctx, record } = makeBatchHarness();
    const calls: CheckCall[] = [];
    const { runner, prompts } = makeFakeRunner(pollsForTurns(1));

    await assert.rejects(
      () =>
        runBatchJob(ctx, {
          loadCheckConfig: async () => ({ ...checkConfig, repairAttempts: 0 }),
          runChecks: makeRunChecks([attemptResult(0, checkRun(), { kind: 'code' })], calls, record),
          createRunner: () => runner,
        }),
      /Checks failed: test exit 1/,
    );

    assert.equal(record().status, 'needs_attention');
    assert.equal(record().repairAttempt, undefined);
    assert.equal(prompts.length, 1);
  });
});

function writeNoChangeArtefact(workspaceDir: string, body: unknown): void {
  const target = path.join(workspaceDir, NO_CHANGE_ARTEFACT_PATH);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(body));
}

describe('runBatchJob zero-change completion gate', () => {
  const explanation = 'The branch already carries the fix, so no edit was needed here.';

  it('asks once, then completes on a valid explanation with nothing committed or pushed', async () => {
    const { ctx, job, record } = makeBatchHarness(['', '']);
    writeNoChangeArtefact(job.workspaceDir, {
      reason: 'already_done',
      explanation,
      evidence: ['src/a.test.ts'],
    });

    const { runner, prompts } = makeFakeRunner(pollsForTurns(2));
    await runBatchJob(ctx, {
      loadCheckConfig: async () => null,
      createRunner: () => runner,
    });

    const agent = record();
    assert.equal(agent.status, 'completed');
    assert.equal(agent.result?.noChange, true);
    assert.equal(agent.noChange?.reason, 'already_done');
    assert.equal(agent.noChange?.explanation, explanation);
    assert.deepEqual(agent.noChange?.evidence, ['src/a.test.ts']);
    assert.equal(agent.filesChanged, 0);
    assert.equal(agent.commitSha, null);
    assert.equal(agent.pushed, false);
    assert.equal(prompts.length, 2, 'the gate sends one follow-up, then stops');
    assert.match(prompts[1], /You finished without changing any files/);
    assert.match(fs.readFileSync(job.logPath, 'utf8'), /No-change explanation accepted \(already_done\)/);
  });

  it('sends the follow-up only once and fails when no explanation is accepted', async () => {
    const { ctx, record } = makeBatchHarness(['', '']);
    const { runner, prompts } = makeFakeRunner(pollsForTurns(2));

    await assert.rejects(
      () => runBatchJob(ctx, { loadCheckConfig: async () => null, createRunner: () => runner }),
      /No changes and no valid explanation/,
    );

    const agent = record();
    assert.equal(agent.status, 'failed');
    assert.equal(agent.result?.noChange, false);
    assert.equal(agent.noChange, null);
    assert.equal(agent.pushed, false);
    assert.equal(prompts.length, 2, 'asked on turn 0 only');
    assert.match(prompts[1], /You finished without changing any files/);
  });

  it('runs the checks when the model edits files after the gate asked', async () => {
    const { ctx, record } = makeBatchHarness(['', ' M src/a.ts']);
    const calls: CheckCall[] = [];
    const { runner, prompts } = makeFakeRunner(pollsForTurns(2));

    await runBatchJob(ctx, {
      loadCheckConfig: async () => checkConfig,
      runChecks: makeRunChecks([attemptResult(0, null)], calls, record),
      createRunner: () => runner,
    });

    const agent = record();
    assert.equal(agent.status, 'completed');
    assert.equal(agent.result?.noChange, false);
    assert.equal(agent.noChange, null);
    assert.equal(agent.filesChanged, 1);
    assert.equal(agent.pushed, true);
    assert.deepEqual(calls.map((call) => call.attempt), [0]);
    assert.equal(prompts.length, 2);
  });

  it('keeps an accepted explanation as a completion with no changes', () => {
    assert.equal(
      resolveBatchCompletionStatus({
        opencodeSuccess: true,
        pushOnFailure: false,
        filesChanged: 0,
        verification: {
          state: 'unverified',
          configSource: 'none',
          maxRepairAttempts: 2,
          attempts: [],
        },
        noChangeExplanation: { reason: 'blocked', explanation, evidence: [] },
      }),
      'completed',
    );
  });
});
