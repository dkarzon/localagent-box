import type {
  AgentCheckRun,
  AgentVerificationAttempt,
  CheckName,
  RepoEnvironmentConfig,
} from '../../../types';
import { MAX_REPAIR_ATTEMPTS } from './environment-config';
import { formatCommandResultBlock, runWorkspaceCommand, type WorkspaceCommandResult } from './workspace-command';

/** Config keys for the checks, in the order they run. `verify` is the fallback. */
export const CHECK_ORDER: readonly ('build' | 'lint' | 'test')[] = ['build', 'lint', 'test'];

/** Host-run checks keep more output than a bootstrap command: the model may act on it. */
export const CHECK_OUTPUT_TAIL_LINES = 200;

/** Fallback when neither `checks.timeoutMs` nor `verifyTimeoutMs` is configured. */
export const DEFAULT_CHECK_TIMEOUT_MS = 600_000;

/** Repair attempts allowed after a failing check when the repo does not set one (v1 1.2). */
export const DEFAULT_REPAIR_ATTEMPTS = 2;

export interface ResolvedCheck {
  name: CheckName;
  command: string;
}

/** Check list in `build`, `lint`, `test` order, or the single `verify` fallback. */
export function buildCheckList(config: RepoEnvironmentConfig | null): ResolvedCheck[] {
  if (!config) {
    return [];
  }

  const checks: ResolvedCheck[] = [];
  for (const name of CHECK_ORDER) {
    const command = config.checks?.[name];
    if (command) {
      checks.push({ name, command });
    }
  }

  if (checks.length === 0 && config.verifyCommand) {
    checks.push({ name: 'verify', command: config.verifyCommand });
  }

  return checks;
}

export function resolveCheckTimeoutMs(config: RepoEnvironmentConfig | null): number {
  return config?.checks?.timeoutMs ?? config?.verifyTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
}

export function resolveMaxRepairAttempts(config: RepoEnvironmentConfig | null): number {
  const attempts = config?.repairAttempts ?? DEFAULT_REPAIR_ATTEMPTS;
  return Math.min(Math.max(attempts, 0), MAX_REPAIR_ATTEMPTS);
}

/** Everything the host needs to run the checks for a single run. */
export interface VerificationSettings {
  checks: ResolvedCheck[];
  timeoutMs: number;
  maxOutputLines: number;
  maxRepairAttempts: number;
  /** Resolved `draftPrOnFailure`; stored on the record so the server needs no workspace. */
  draftPrOnFailure: boolean;
  configSource: 'base' | 'none' | 'unavailable';
}

/**
 * `available` is false when the base branch could not be read: no checks run, and the
 * record says the config was unreadable rather than absent.
 */
export function resolveVerificationSettings(
  config: RepoEnvironmentConfig | null,
  available = true,
): VerificationSettings {
  return {
    checks: buildCheckList(config),
    timeoutMs: resolveCheckTimeoutMs(config),
    maxOutputLines: CHECK_OUTPUT_TAIL_LINES,
    maxRepairAttempts: resolveMaxRepairAttempts(config),
    draftPrOnFailure: config?.draftPrOnFailure === true,
    configSource: !available ? 'unavailable' : config ? 'base' : 'none',
  };
}

export type FailureKind = 'code' | 'machine';

export interface FailureClassification {
  kind: FailureKind;
  reason: string;
}

/**
 * Machine failures are infrastructure, not code, so they never earn a repair
 * turn (v1 1.2). Anything else is the agent's own failure.
 */
export function classifyFailure(run: AgentCheckRun): FailureClassification {
  if (run.timedOut) {
    return { kind: 'machine', reason: 'timeout' };
  }
  if (run.exitCode === 137 || run.signal === 'SIGKILL') {
    return { kind: 'machine', reason: 'oom' };
  }
  if (/JavaScript heap out of memory|Cannot allocate memory|Killed\s*$/m.test(run.outputTail)) {
    return { kind: 'machine', reason: 'oom' };
  }
  if (/ENOSPC|No space left on device/.test(run.outputTail)) {
    return { kind: 'machine', reason: 'disk_full' };
  }
  if (
    run.exitCode === 127 ||
    /command not found|is not recognized as an internal or external command/.test(run.outputTail)
  ) {
    return { kind: 'machine', reason: 'command_not_found' };
  }
  return { kind: 'code', reason: `exit ${run.exitCode}` };
}

export interface RunChecksDeps {
  /** Attempt index recorded on the attempt: 0 is after the task turn, 1..n after repair n. */
  attempt: number;
  timeoutMs?: number;
  maxOutputLines?: number;
  /** Injectable for tests; defaults to `runWorkspaceCommand`. */
  runCommand?: typeof runWorkspaceCommand;
  /** Env merged over `process.env` for the check shell. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Run the checks in order, stopping at the first failure, and return the attempt
 * the host records. Host-run code: the model never decides whether a check passed.
 */
export async function runChecks(
  workspaceDir: string,
  checks: readonly ResolvedCheck[],
  deps: RunChecksDeps,
): Promise<AgentVerificationAttempt> {
  const runCommand = deps.runCommand ?? runWorkspaceCommand;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const maxOutputLines = deps.maxOutputLines ?? CHECK_OUTPUT_TAIL_LINES;
  const startedAt = new Date().toISOString();

  const runs: AgentCheckRun[] = [];
  let failing: AgentCheckRun | null = null;

  for (const check of checks) {
    const result = await runCommand(workspaceDir, check.command, {
      timeoutMs,
      maxOutputLines,
      env: deps.env,
    });
    const run: AgentCheckRun = {
      name: check.name,
      command: check.command,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      outputTail: result.outputTail,
    };
    runs.push(run);
    if (!result.success) {
      failing = run;
      break;
    }
  }

  const attempt: AgentVerificationAttempt = {
    attempt: deps.attempt,
    startedAt,
    finishedAt: new Date().toISOString(),
    checks: runs,
    passed: failing === null,
  };

  if (failing) {
    const classification = classifyFailure(failing);
    attempt.failureKind = classification.kind;
    if (classification.kind === 'machine') {
      attempt.machineReason = classification.reason;
    }
  }

  return attempt;
}

/** Rebuilds the runner result shape from a recorded check run, for the log/injection block. */
export function checkResultBlock(run: AgentCheckRun, heading: string): string {
  const result: WorkspaceCommandResult = {
    command: run.command,
    exitCode: run.exitCode,
    signal: run.signal as NodeJS.Signals | null,
    durationMs: run.durationMs,
    outputTail: run.outputTail,
    timedOut: run.timedOut,
    success: !run.timedOut && run.exitCode === 0,
  };
  return formatCommandResultBlock(result, heading);
}

/**
 * Follow-up turn for a code failure (v1 1.2). Machine failures never reach this:
 * they are infrastructure, so there is nothing the model could fix.
 */
export function buildRepairPrompt(params: {
  attempt: number;
  max: number;
  failingCheck: AgentCheckRun;
}): string {
  return [
    `Host-run checks failed after your changes (repair attempt ${params.attempt} of ${params.max}).`,
    '',
    checkResultBlock(params.failingCheck, 'Failed check'),
    '',
    'Fix the cause so this command passes. Do not change the check command or the',
    'check configuration. Do not commit or push; the host does that. When done,',
    'briefly state what you changed and why.',
  ].join('\n');
}
