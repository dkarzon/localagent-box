import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentCheckRun, RepoEnvironmentConfig } from '../../../types';
import type { RunWorkspaceCommandOptions, WorkspaceCommandResult } from './workspace-command';
import {
  buildCheckList,
  buildRepairPrompt,
  checkResultBlock,
  classifyFailure,
  resolveCheckTimeoutMs,
  resolveMaxRepairAttempts,
  resolveVerificationSettings,
  runChecks,
} from './verification';
import { runWorkspaceCommand } from './workspace-command';

const baseRun: WorkspaceCommandResult = {
  command: '',
  exitCode: 0,
  signal: null,
  durationMs: 12,
  outputTail: '',
  timedOut: false,
  success: true,
};

interface CapturedCall {
  command: string;
  timeoutMs: number;
  maxOutputLines: number;
}

/** Fake runner: results keyed by command, with each call captured in order. */
function makeRunCommand(
  results: Record<string, Partial<WorkspaceCommandResult>>,
  calls: CapturedCall[],
): typeof runWorkspaceCommand {
  return (async (
    _workspaceDir: string,
    command: string,
    options: RunWorkspaceCommandOptions = {},
  ): Promise<WorkspaceCommandResult> => {
    calls.push({
      command,
      timeoutMs: options.timeoutMs ?? 0,
      maxOutputLines: options.maxOutputLines ?? 0,
    });
    const override = results[command] ?? {};
    return { ...baseRun, command, ...override, success: (override.exitCode ?? 0) === 0 };
  }) as typeof runWorkspaceCommand;
}

describe('buildCheckList', () => {
  it('returns checks in build, lint, test order', () => {
    const config: RepoEnvironmentConfig = {
      version: 1,
      checks: { test: 'npm test', build: 'npm run build', lint: 'npm run lint' },
    };
    assert.deepEqual(buildCheckList(config).map((check) => check.name), ['build', 'lint', 'test']);
  });

  it('includes only the configured checks', () => {
    const config: RepoEnvironmentConfig = { version: 1, checks: { lint: 'npm run lint' } };
    assert.deepEqual(buildCheckList(config), [{ name: 'lint', command: 'npm run lint' }]);
  });

  it('falls back to a single verify check when none of the three is configured', () => {
    const config: RepoEnvironmentConfig = {
      version: 1,
      verifyCommand: 'npm test --passWithNoTests',
    };
    assert.deepEqual(buildCheckList(config), [
      { name: 'verify', command: 'npm test --passWithNoTests' },
    ]);
  });

  it('returns no checks when nothing is configured', () => {
    assert.deepEqual(buildCheckList(null), []);
    assert.deepEqual(buildCheckList({ version: 1 }), []);
  });

  it('prefers checks.timeoutMs, then verifyTimeoutMs, then the default', () => {
    assert.equal(resolveCheckTimeoutMs({ version: 1, checks: { timeoutMs: 300_000 }, verifyTimeoutMs: 100_000 }), 300_000);
    assert.equal(resolveCheckTimeoutMs({ version: 1, verifyTimeoutMs: 100_000 }), 100_000);
    assert.equal(resolveCheckTimeoutMs({ version: 1 }), 600_000);
    assert.equal(resolveCheckTimeoutMs(null), 600_000);
  });

  it('defaults repair attempts to 2 and clamps to 0..3', () => {
    assert.equal(resolveMaxRepairAttempts({ version: 1 }), 2);
    assert.equal(resolveMaxRepairAttempts({ version: 1, repairAttempts: 1 }), 1);
    assert.equal(resolveMaxRepairAttempts({ version: 1, repairAttempts: 3 }), 3);
    assert.equal(resolveMaxRepairAttempts({ version: 1, repairAttempts: 9 }), 3);
    assert.equal(resolveMaxRepairAttempts({ version: 1, repairAttempts: -1 }), 0);
  });
});

describe('runChecks', () => {
  it('runs every check in order and passes when all succeed', async () => {
    const calls: CapturedCall[] = [];
    const runCommand = makeRunCommand(
      {
        'npm run build': { exitCode: 0 },
        'npm run lint': { exitCode: 0 },
        'npm test': { exitCode: 0 },
      },
      calls,
    );

    const attempt = await runChecks(
      '/tmp/workspace',
      buildCheckList({
        version: 1,
        checks: { build: 'npm run build', lint: 'npm run lint', test: 'npm test' },
      }),
      { attempt: 0, runCommand },
    );

    assert.equal(attempt.passed, true);
    assert.equal(attempt.failureKind, undefined);
    assert.deepEqual(attempt.checks.map((run) => run.name), ['build', 'lint', 'test']);
    assert.deepEqual(calls.map((call) => call.command), ['npm run build', 'npm run lint', 'npm test']);
    assert.equal(attempt.attempt, 0);
    assert.ok(attempt.startedAt <= attempt.finishedAt);
  });

  it('stops at the first failing check', async () => {
    const calls: CapturedCall[] = [];
    const runCommand = makeRunCommand(
      {
        'npm run build': { exitCode: 0 },
        'npm run lint': { exitCode: 1, outputTail: 'lint error', success: false },
        'npm test': { exitCode: 0 },
      },
      calls,
    );

    const attempt = await runChecks(
      '/tmp/workspace',
      buildCheckList({
        version: 1,
        checks: { build: 'npm run build', lint: 'npm run lint', test: 'npm test' },
      }),
      { attempt: 1, runCommand },
    );

    assert.equal(attempt.passed, false);
    assert.equal(attempt.failureKind, 'code');
    assert.equal(attempt.machineReason, undefined);
    assert.deepEqual(attempt.checks.map((run) => run.name), ['build', 'lint']);
    assert.equal(calls.length, 2);
    assert.equal(attempt.attempt, 1);
  });

  it('uses the timeout and tail from the deps, with defaults when omitted', async () => {
    const calls: CapturedCall[] = [];
    const runCommand = makeRunCommand({}, calls);

    await runChecks('/tmp/workspace', buildCheckList({ version: 1, checks: { build: 'npm run build' } }), {
      attempt: 0,
      runCommand,
    });

    assert.equal(calls[0]?.timeoutMs, 600_000);
    assert.equal(calls[0]?.maxOutputLines, 200);

    calls.length = 0;
    await runChecks(
      '/tmp/workspace',
      resolveVerificationSettings({ version: 1, checks: { build: 'npm run build', timeoutMs: 45_000 } }).checks,
      { attempt: 0, runCommand, timeoutMs: 45_000 },
    );
    assert.equal(calls[0]?.timeoutMs, 45_000);
    assert.equal(calls[0]?.maxOutputLines, 200);
  });

  it('records a machine failure when the failing check is a machine problem', async () => {
    const calls: CapturedCall[] = [];
    const runCommand = makeRunCommand(
      { 'npm test': { exitCode: 124, timedOut: true, success: false, outputTail: '' } },
      calls,
    );

    const attempt = await runChecks(
      '/tmp/workspace',
      buildCheckList({ version: 1, checks: { test: 'npm test' } }),
      { attempt: 2, runCommand },
    );

    assert.equal(attempt.passed, false);
    assert.equal(attempt.failureKind, 'machine');
    assert.equal(attempt.machineReason, 'timeout');
    assert.equal(attempt.checks[0]?.timedOut, true);
  });

  it('treats an empty check list as nothing to run', async () => {
    const calls: CapturedCall[] = [];
    const attempt = await runChecks('/tmp/workspace', [], {
      attempt: 0,
      runCommand: makeRunCommand({}, calls),
    });

    assert.equal(calls.length, 0);
    assert.deepEqual(attempt.checks, []);
    assert.equal(attempt.passed, true);
  });
});

describe('classifyFailure', () => {
  const run = (overrides: Partial<AgentCheckRun>): AgentCheckRun => ({
    name: 'test',
    command: 'npm test',
    exitCode: 1,
    signal: null,
    timedOut: false,
    durationMs: 100,
    outputTail: '',
    ...overrides,
  });

  it('classifies a timeout as machine', () => {
    assert.deepEqual(classifyFailure(run({ exitCode: 124, timedOut: true })), {
      kind: 'machine',
      reason: 'timeout',
    });
  });

  it('classifies an OOM kill as machine', () => {
    assert.deepEqual(classifyFailure(run({ exitCode: 137, signal: 'SIGKILL' })), {
      kind: 'machine',
      reason: 'oom',
    });
    assert.deepEqual(classifyFailure(run({ outputTail: 'JavaScript heap out of memory' })), {
      kind: 'machine',
      reason: 'oom',
    });
    assert.deepEqual(classifyFailure(run({ outputTail: 'foo\nKilled' })), {
      kind: 'machine',
      reason: 'oom',
    });
  });

  it('classifies a full disk as machine', () => {
    assert.deepEqual(classifyFailure(run({ outputTail: 'write ENOSPC' })), {
      kind: 'machine',
      reason: 'disk_full',
    });
    assert.deepEqual(classifyFailure(run({ outputTail: 'No space left on device' })), {
      kind: 'machine',
      reason: 'disk_full',
    });
  });

  it('classifies a missing command as machine', () => {
    assert.deepEqual(classifyFailure(run({ exitCode: 127 })), {
      kind: 'machine',
      reason: 'command_not_found',
    });
    assert.deepEqual(classifyFailure(run({ outputTail: 'sh: pnpm: command not found' })), {
      kind: 'machine',
      reason: 'command_not_found',
    });
  });

  it('leaves an ordinary failing check as a code failure', () => {
    assert.deepEqual(classifyFailure(run({ outputTail: '1 test failed' })), {
      kind: 'code',
      reason: 'exit 1',
    });
  });
});

describe('checkResultBlock', () => {
  it('formats a failing check for the log and the repair prompt', () => {
    const block = checkResultBlock(
      {
        name: 'test',
        command: 'npm test',
        exitCode: 1,
        signal: null,
        timedOut: false,
        durationMs: 4200,
        outputTail: '1 test failed',
      },
      'Failed check',
    );
    assert.equal(block, '## Failed check (host-run: `npm test`)\nexit=1\n1 test failed');
  });

  it('marks a timed-out check', () => {
    const block = checkResultBlock(
      {
        name: 'build',
        command: 'npm run build',
        exitCode: 124,
        signal: null,
        timedOut: true,
        durationMs: 600000,
        outputTail: '',
      },
      'Check build',
    );
    assert.equal(block, '## Check build (host-run: `npm run build`)\nexit=124 (timed out)\n(no output)');
  });
});

describe('buildRepairPrompt', () => {
  const failingCheck: AgentCheckRun = {
    name: 'test',
    command: 'npm test',
    exitCode: 1,
    signal: null,
    timedOut: false,
    durationMs: 4200,
    outputTail: '1 test failed',
  };

  it('names the attempt, shows the failing check and forbids changing the check', () => {
    assert.equal(
      buildRepairPrompt({ attempt: 2, max: 2, failingCheck }),
      [
        'Host-run checks failed after your changes (repair attempt 2 of 2).',
        '',
        '## Failed check (host-run: `npm test`)',
        'exit=1',
        '1 test failed',
        '',
        'Fix the cause so this command passes. Do not change the check command or the',
        'check configuration. Do not commit or push; the host does that. When done,',
        'briefly state what you changed and why.',
      ].join('\n'),
    );
  });
});

describe('resolveVerificationSettings', () => {
  it('uses the base config and reports where it came from', () => {
    const settings = resolveVerificationSettings({
      version: 1,
      checks: { build: 'npm run build' },
      repairAttempts: 1,
    });
    assert.deepEqual(settings.checks, [{ name: 'build', command: 'npm run build' }]);
    assert.equal(settings.configSource, 'base');
    assert.equal(settings.maxRepairAttempts, 1);
    assert.equal(settings.maxOutputLines, 200);
    assert.equal(settings.timeoutMs, 600_000);
    assert.equal(settings.draftPrOnFailure, false);
  });

  it('resolves draftPrOnFailure from the base config', () => {
    assert.equal(
      resolveVerificationSettings({ version: 1, checks: { test: 'npm test' }, draftPrOnFailure: true })
        .draftPrOnFailure,
      true,
    );
  });

  it('reports `none` when no config is available', () => {
    const settings = resolveVerificationSettings(null);
    assert.deepEqual(settings.checks, []);
    assert.equal(settings.configSource, 'none');
    assert.equal(settings.maxRepairAttempts, 2);
    assert.equal(settings.draftPrOnFailure, false);
  });
});
