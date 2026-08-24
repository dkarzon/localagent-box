import { spawn } from 'child_process';

export const DEFAULT_WORKSPACE_COMMAND_TIMEOUT_MS = 120_000;
export const MAX_WORKSPACE_COMMAND_OUTPUT_LINES = 50;
const KILL_GRACE_MS = 5_000;

export interface WorkspaceCommandResult {
  command: string;
  exitCode: number;
  outputTail: string;
  timedOut: boolean;
  success: boolean;
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

    const finish = (result: WorkspaceCommandResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(killGraceTimer);
      resolve(result);
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
        outputTail: tailOutputLines(message, maxOutputLines),
        timedOut: false,
        success: false,
      });
    });

    child.on('close', (code) => {
      const exitCode = timedOut ? 124 : (code ?? 1);
      finish({
        command,
        exitCode,
        outputTail: tailOutputLines(combined, maxOutputLines),
        timedOut,
        success: !timedOut && exitCode === 0,
      });
    });
  });
}
