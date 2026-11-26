import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Agent, AgentVerification } from '../types';
import { canCreatePullRequest } from './agent-pull-request';

function failedVerification(overrides: Partial<AgentVerification> = {}): AgentVerification {
  return {
    state: 'failed',
    configSource: 'base',
    maxRepairAttempts: 2,
    draftPrOnFailure: false,
    attempts: [],
    ...overrides,
  };
}

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    agentId: 'agent-1',
    workspaceId: 'ws',
    repoId: 'repo-1',
    mode: 'batch',
    prompt: '',
    systemPrompt: null,
    baseBranch: 'main',
    agentBranch: 'localagent-feature',
    commitMessage: '',
    push: false,
    pushOnFailure: false,
    model: null,
    status: 'completed',
    commitSha: null,
    pushed: true,
    filesChanged: 1,
    createdAt: '2026-11-26T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    branch: null,
    error: null,
    result: {
      branch: 'localagent-feature',
      baseBranch: 'main',
      workspaceId: 'ws',
      commitSha: null,
      pushed: true,
      filesChanged: 1,
      warning: null,
      opencodeSuccess: true,
    },
    pullRequest: null,
    ...overrides,
  } as Agent;
}

describe('canCreatePullRequest', () => {
  it('allows a completed run with a pushed branch and no PR yet', () => {
    assert.equal(canCreatePullRequest(agent()), true);
  });

  it('needs the OpenCode turn to have succeeded when the run completed', () => {
    assert.equal(
      canCreatePullRequest(agent({ result: { ...agent().result!, opencodeSuccess: false } })),
      false,
    );
  });

  it('needs the branch pushed and no PR already linked', () => {
    assert.equal(canCreatePullRequest(agent({ pushed: false })), false);
    assert.equal(
      canCreatePullRequest(agent({ pullRequest: { number: 1, url: '', state: 'open', title: '', createdAt: '', mergedAt: null, updatedAt: '' } })),
      false,
    );
  });

  it('allows needs attention only when the repo asked for a draft PR on failure', () => {
    assert.equal(
      canCreatePullRequest(agent({ status: 'needs_attention', verification: failedVerification({ draftPrOnFailure: true }) })),
      true,
    );
    assert.equal(
      canCreatePullRequest(agent({ status: 'needs_attention', verification: failedVerification() })),
      false,
    );
    assert.equal(canCreatePullRequest(agent({ status: 'needs_attention' })), false);
  });

  it('does not open a PR for a machine failure', () => {
    assert.equal(
      canCreatePullRequest(
        agent({
          status: 'failed_machine',
          verification: failedVerification({ state: 'machine_failure', draftPrOnFailure: true }),
        }),
      ),
      false,
    );
  });
});
