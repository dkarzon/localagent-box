import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentJob, AgentVerification, AppConfig } from '../../../types';
import {
  resolveAutoApprovePermissions,
  resolveBatchCompletionStatus,
  resolveBatchFailureMessage,
} from './batch-run-flow';

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

  it('fails when a check failed, even with changes', () => {
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
      'failed',
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
