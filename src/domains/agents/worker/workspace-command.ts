import os from 'os';
import { spawn } from 'child_process';
import { registerChildCleanup } from '../../../lib/child-cleanup';

export const DEFAULT_WORKSPACE_COMMAND_TIMEOUT_MS = 120_000;
export const MAX_WORKSPACE_COMMAND_OUTPUT_LINES = 50;
const KILL_GRACE_MS = 5_000;

export interface WorkspaceCommandResult {
  command: string;
  /** Exit code, or `128 + signal number` when the process was killed by a signal. */
  exitCode: number;
  /** Signal the process exited on, or null when it exited normally (or timed out). */
  signal: NodeJS.Signals | null;
  durationMs: number;
  outputTail: string;
  timedOut: boolean;
  success: boolean;
}

/** Shell convention for a signal kill: 128 + signal number (SIGKILL is 137). */
export function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + (os.constants.signals[signal] ?? 0);
}

export interface RunWorkspaceCommandOptions {
  timeoutMs?: number;
  maxOutputLines?: number;
  spawnImpl?: typeof spawn;
  /** Entries merged over `process.env` for the spawned shell. */
  env?: NodeJS.ProcessEnv;
}

export function tailOutputLines(output: string, maxLines: number): string {
  const lines = output.split(/\r?\n/);
  if (lines.length <= maxLines) {
    return output.trimEnd();
  }
  return lines.slice(-maxLines).join('\n');
}

/** Markdown block for a host-run command result, injected into a model turn. */
export function formatCommandResultBlock(
  result: WorkspaceCommandResult,
  heading = 'Check result',
): string {
  const statusSuffix = result.timedOut ? ' (timed out)' : '';
  return [
    `## ${heading} (host-run: \`${result.command}\`)`,
    `exit=${result.exitCode}${statusSuffix}`,
    result.outputTail.trim() || '(no output)',
  ].join('\n');
}

/**
 * Run a shell command inside the workspace directory.
 * Captures combined stdout/stderr tail and enforces a bounded timeout.
 * Uses `cmd.exe /c` on Windows and `sh -c` elsewhere, spawns the command in
 * its own (detached) process group, and terminates the whole group on timeout
 * with SIGTERM followed by SIGKILL after a short grace period.
 */
export function runWorkspaceCommand(
  workspaceDir: string,
  command: string,
  options: RunWorkspaceCommandOptions = {},
): Promise<WorkspaceCommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WORKSPACE_COMMAND_TIMEOUT_MS;
  const maxOutputLines = options.maxOutputLines ?? MAX_WORKSPACE_COMMAND_OUTPUT_LINES;
  const spawnImpl = options.spawnImpl ?? spawn;
  const env: NodeJS.ProcessEnv = options.env
    ? { ...process.env, ...options.env }
    : process.env;

  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const child = spawnImpl(isWin ? 'cmd.exe' : 'sh', isWin ? ['/c', command] : ['-c', command], {
      cwd: workspaceDir,
      env,
      detached: !isWin,
    });

    const startedAt = Date.now();
    let combined = '';
    let timedOut = false;
    let settled = false;

    const trimCombined = () => {
      const lines = combined.split(/\r?\n/);
      if (lines.length > maxOutputLines + 1) {
        combined = lines.slice(-(maxOutputLines + 1)).join('\n');
      }
    };

    const appendChunk = (chunk: Buffer | string) => {
      combined += chunk.toString();
      trimCombined();
    };

    /** Result without `durationMs`: filled in from the spawn time when the run settles. */
    type CommandOutcome = Omit<WorkspaceCommandResult, 'durationMs'>;

    const finish = (result: CommandOutcome) => {
      if (settled) {
        return;
      }
      settled = true;
      unregisterCleanup();
      clearTimeout(timer);
      clearTimeout(killGraceTimer);
      resolve({ ...result, durationMs: Date.now() - startedAt });
    };

    const killProcessTree = (signal: NodeJS.Signals = 'SIGTERM') => {
      if (!child.pid) {
        child.kill(signal);
        return;
      }
      if (isWin) {
        child.kill(signal);
        return;
      }
      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };

    // If the worker is terminated mid-command, kill the whole process group
    // (it is detached, so it would not receive the worker's signal).
    const unregisterCleanup = registerChildCleanup(() => killProcessTree('SIGKILL'));

    child.stdout?.on('data', appendChunk);
    child.stderr?.on('data', appendChunk);

    let killGraceTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree('SIGTERM');
      killGraceTimer = setTimeout(() => {
        killProcessTree('SIGKILL');
        finish({
          command,
          exitCode: 124,
          signal: null,
          outputTail: tailOutputLines(combined, maxOutputLines),
          timedOut: true,
          success: false,
        });
      }, KILL_GRACE_MS);
    }, timeoutMs);

    child.on('error', (err) => {
      const message = err instanceof Error ? err.message : String(err);
      finish({
        command,
        exitCode: 1,
        signal: null,
        outputTail: tailOutputLines(message, maxOutputLines),
        timedOut: false,
        success: false,
      });
    });

    child.on('close', (code, signal) => {
      // A signal kill (OOM, an outside SIGKILL) has no exit code, so report the
      // shell convention; otherwise a null code is a plain failure.
      const exitCode = timedOut ? 124 : (code ?? (signal ? signalExitCode(signal) : 1));
      finish({
        command,
        exitCode,
        signal: timedOut ? null : (signal ?? null),
        outputTail: tailOutputLines(combined, maxOutputLines),
        timedOut,
        success: !timedOut && exitCode === 0,
      });
    });
  });
}
