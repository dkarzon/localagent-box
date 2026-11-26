import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Agent, AgentCheckRun, AgentVerification, AgentVerificationAttempt } from '../types';
import {
  buildHostTestPlanSection,
  canCreatePullRequest,
  stripModelTestPlanSection,
} from './agent-pull-request';

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

function checkRun(overrides: Partial<AgentCheckRun> = {}): AgentCheckRun {
  return {
    name: 'test',
    command: 'npm test',
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 1500,
    outputTail: '',
    ...overrides,
  };
}

function attempt(overrides: Partial<AgentVerificationAttempt> = {}): AgentVerificationAttempt {
  return {
    attempt: 0,
    startedAt: '2026-11-26T00:01:00.000Z',
    finishedAt: '2026-11-26T00:01:02.000Z',
    checks: [],
    passed: true,
    ...overrides,
  };
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

  it('does not open a PR for a run that completed on a no-change explanation', () => {
    assert.equal(
      canCreatePullRequest(agent({ result: { ...agent().result!, noChange: true } })),
      false,
    );
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

describe('buildHostTestPlanSection', () => {
  const unconfiguredNote =
    '⚠️ Unverified — no build/lint/test checks are configured for this repo (`.localagent-box/environment.json` on the base branch).';

  it('states that nothing was verified when the repo has no checks configured', () => {
    assert.equal(buildHostTestPlanSection(undefined), `## Test plan\n\n${unconfiguredNote}`);
    assert.equal(
      buildHostTestPlanSection(failedVerification({ configSource: 'none' })),
      `## Test plan\n\n${unconfiguredNote}`,
    );
  });

  it('states that nothing was verified when the configured checks never ran', () => {
    assert.match(
      buildHostTestPlanSection(failedVerification({ state: 'unverified' })),
      /⚠️ Unverified — the configured checks did not run\./,
    );
  });

  it('tabulates the last attempt for a run that passed after a repair', () => {
    const section = buildHostTestPlanSection(
      failedVerification({
        state: 'passed',
        attempts: [
          attempt({
            checks: [checkRun({ name: 'build', command: 'npm run build', exitCode: 1 })],
            passed: false,
            failureKind: 'code',
          }),
          attempt({
            attempt: 1,
            checks: [checkRun({ name: 'build', command: 'npm run build' }), checkRun()],
          }),
        ],
      }),
    );

    assert.match(section, /^## Test plan$/m);
    assert.match(section, /^\| Check \| Command \| Result \| Attempts \|$/m);
    assert.match(section, /\| build \| `npm run build` \| ✅ passed \| 2 \|/);
    // `test` only ran on the second attempt: the first stopped at the failing build.
    assert.match(section, /\| test \| `npm test` \| ✅ passed \| 1 \|/);
    assert.match(section, /Repair attempts: 1 of 2/);
    assert.doesNotMatch(section, /needs attention/);
  });

  it('shows the failing checks and flags a draft PR that needs attention', () => {
    const failing = checkRun({ exitCode: 1 });
    const section = buildHostTestPlanSection(
      failedVerification({
        attempts: [
          attempt({ checks: [failing], passed: false, failureKind: 'code' }),
          attempt({ attempt: 1, checks: [failing], passed: false, failureKind: 'code' }),
          attempt({ attempt: 2, checks: [failing], passed: false, failureKind: 'code' }),
        ],
      }),
      'needs_attention',
    );

    assert.match(section, /\| test \| `npm test` \| ❌ exit 1 \| 3 \|/);
    assert.match(section, /Repair attempts: 2 of 2/);
    assert.match(section, /\*\*Checks still failing — this draft PR needs attention\.\*\*/);
  });

  it('reports a timed-out check as timed out and does not ask for attention on a machine failure', () => {
    const section = buildHostTestPlanSection(
      failedVerification({
        state: 'machine_failure',
        attempts: [
          attempt({
            checks: [
              checkRun({ name: 'lint', command: 'npm run lint', exitCode: 124, timedOut: true, signal: 'SIGTERM' }),
            ],
            passed: false,
            failureKind: 'machine',
            machineReason: 'timeout',
          }),
        ],
      }),
      'failed_machine',
    );

    assert.match(section, /\| lint \| `npm run lint` \| ⏱ timed out \| 1 \|/);
    assert.match(section, /Repair attempts: 0 of 2/);
    assert.doesNotMatch(section, /needs attention/);
  });

  it('escapes pipes in a command so the table stays readable', () => {
    const section = buildHostTestPlanSection(
      failedVerification({
        state: 'passed',
        attempts: [attempt({ checks: [checkRun({ name: 'test', command: 'npm test -- --filter a|b' })] })],
      }),
    );

    assert.match(section, /\| test \| `npm test -- --filter a\\\|b` \| ✅ passed \| 1 \|/);
  });
});

describe('stripModelTestPlanSection', () => {
  it('removes the model test plan between the summary and the footer', () => {
    const body = [
      '## Summary',
      '',
      '- Added retry backoff.',
      '',
      '## Test plan',
      '',
      '- [ ] Run the webhook tests.',
      '',
      '---',
      '',
      'Created from a Local Agent Box session.',
    ].join('\n');

    assert.equal(
      stripModelTestPlanSection(body),
      '## Summary\n\n- Added retry backoff.\n\n---\n\nCreated from a Local Agent Box session.',
    );
  });

  it('removes a test plan that runs to the end of the body', () => {
    assert.equal(
      stripModelTestPlanSection('## Summary\n\n- Fix the parser.\n\n## Test plan\n\n- [ ] Run tests'),
      '## Summary\n\n- Fix the parser.',
    );
  });

  it('leaves a body with no test plan alone', () => {
    const body = '## Summary\n\n- Fix the parser.';
    assert.equal(stripModelTestPlanSection(body), body);
  });
});
