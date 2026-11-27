import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentCheckRun, AgentVerification, AgentVerificationAttempt } from '../../../types';
import {
  ESCALATION_MAX_FIELD_CHARS,
  buildEscalation,
  escalationSummary,
  truncateForRecord,
} from './escalation';

function run(overrides: Partial<AgentCheckRun> = {}): AgentCheckRun {
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

function attempt(
  index: number,
  checks: AgentCheckRun[],
  extra: Partial<AgentVerificationAttempt> = {},
): AgentVerificationAttempt {
  return {
    attempt: index,
    startedAt: `2026-11-26T00:00:0${index}.000Z`,
    finishedAt: `2026-11-26T00:00:1${index}.000Z`,
    checks,
    passed: checks.length === 0,
    ...extra,
  };
}

function verification(
  state: AgentVerification['state'],
  attempts: AgentVerificationAttempt[],
): AgentVerification {
  return { state, configSource: 'base', maxRepairAttempts: 2, attempts };
}

describe('truncateForRecord', () => {
  it('truncates to the recorded length', () => {
    const long = 'x'.repeat(ESCALATION_MAX_FIELD_CHARS + 10);
    const truncated = truncateForRecord(long);
    assert.equal(truncated.length, ESCALATION_MAX_FIELD_CHARS + 1);
    assert.ok(truncated.endsWith('…'));
  });

  it('keeps short text and trims surrounding whitespace', () => {
    assert.equal(truncateForRecord('  src/a.ts | 1 +  '), 'src/a.ts | 1 +');
  });
});

describe('escalationSummary', () => {
  it('names the check still failing and the repairs used', () => {
    const v = verification('failed', [
      attempt(0, [run()]),
      attempt(1, [run()]),
      attempt(2, [run()]),
    ]);
    assert.equal(escalationSummary(v, 'needs_attention'), 'test still failing after 2 repair attempt(s)');
  });

  it('says when no repair turn was allowed', () => {
    const v = verification('failed', [attempt(0, [run()])]);
    assert.equal(escalationSummary(v, 'needs_attention'), 'test failing with no repair attempts allowed');
  });

  it('names the machine reason and the check for a machine failure', () => {
    const v = verification('machine_failure', [
      attempt(0, [run({ name: 'build', command: 'npm run build', exitCode: 137, signal: 'SIGKILL', outputTail: 'Killed' })], {
        failureKind: 'machine',
        machineReason: 'oom',
      }),
    ]);
    assert.equal(escalationSummary(v, 'failed_machine'), 'Machine failure (oom) during build');
  });

  it('falls back to a plain line when no check failed', () => {
    assert.equal(escalationSummary(verification('failed', []), 'needs_attention'), 'Checks still failing');
  });
});

describe('buildEscalation', () => {
  it('reports the failing check plus every attempt with its diff stat and reasoning', () => {
    const v = verification('failed', [
      attempt(0, [run()], { diffStat: 'src/a.ts | 2 +', assistantText: 'I changed the assertion.' }),
      attempt(1, [run({ name: 'lint', command: 'npm run lint', exitCode: 1, outputTail: '1 problem' })], {
        diffStat: 'src/a.ts | 2 +\nsrc/b.ts | 1 -',
        assistantText: 'Fixed the lint error.',
      }),
      attempt(2, [run()], { diffStat: 'src/a.ts | 3 +', assistantText: 'Still failing.' }),
    ]);

    const escalation = buildEscalation(v, 'needs_attention');
    assert.ok(escalation);
    assert.equal(escalation.summary, 'test still failing after 2 repair attempt(s)');
    assert.deepEqual(escalation.failingCheck, {
      name: 'test',
      command: 'npm test',
      exitCode: 1,
      outputTail: '1 test failed',
    });
    assert.equal(escalation.attempts.length, 3);
    assert.deepEqual(
      escalation.attempts.map((entry) => [entry.attempt, entry.failedCheck]),
      [[0, 'test'], [1, 'lint'], [2, 'test']],
    );
    assert.equal(escalation.attempts[1]?.diffStat, 'src/a.ts | 2 +\nsrc/b.ts | 1 -');
    assert.equal(escalation.attempts[2]?.assistantText, 'Still failing.');
  });

  it('leaves failedCheck off an attempt that passed', () => {
    const v = verification('failed', [attempt(0, [run({ exitCode: 0, outputTail: '' })], { passed: true })]);
    const escalation = buildEscalation(v, 'needs_attention');
    assert.ok(escalation);
    assert.equal(escalation.attempts[0]?.failedCheck, undefined);
  });

  it('truncates a long output tail', () => {
    const v = verification('machine_failure', [
      attempt(0, [run({ name: 'build', outputTail: 'y'.repeat(ESCALATION_MAX_FIELD_CHARS + 100) })], {
        failureKind: 'machine',
        machineReason: 'disk_full',
      }),
    ]);
    const escalation = buildEscalation(v, 'failed_machine');
    assert.ok(escalation);
    assert.equal(escalation.failingCheck.outputTail.length, ESCALATION_MAX_FIELD_CHARS + 1);
    assert.equal(escalation.summary, 'Machine failure (disk_full) during build');
  });

  it('returns null when there is nothing to escalate', () => {
    assert.equal(buildEscalation(verification('passed', [attempt(0, [], { passed: true })]), 'needs_attention'), null);
  });
});
