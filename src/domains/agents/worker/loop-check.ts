import { spawn } from 'child_process';

export const DEFAULT_CHECK_COMMAND_TIMEOUT_MS = 120_000;
export const MAX_CHECK_OUTPUT_LINES = 50;
const KILL_GRACE_MS = 5_000;

export interface LoopCheckResult {
  command: string;
  exitCode: number;
  outputTail: string;
  timedOut: boolean;
  success: boolean;
}

export interface RunLoopCheckCommandOptions {
  timeoutMs?: number;
  maxOutputLines?: number;
  spawnImpl?: typeof spawn;
}

export function tailOutputLines(output: string, maxLines: number): string {
  const lines = output.split(/\r?\n/);
  if (lines.length <= maxLines) {
    return output.trimEnd();
  }
  return lines.slice(-maxLines).join('\n');
}

export function formatCheckResultBlock(result: LoopCheckResult): string {
  const statusSuffix = result.timedOut ? ' (timed out)' : '';
  return [
    `## Check result (host-run: \`${result.command}\`)`,
    `exit=${result.exitCode}${statusSuffix}`,
    result.outputTail.trim() || '(no output)',
  ].join('\n');
}

/**
 * Run a repo-configured shell command in the workspace after ACT.
 * Captures combined stdout/stderr tail and enforces a bounded timeout.
 */
export function runLoopCheckCommand(
  workspaceDir: string,
  command: string,
  options: RunLoopCheckCommandOptions = {},
): Promise<LoopCheckResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHECK_COMMAND_TIMEOUT_MS;
  const maxOutputLines = options.maxOutputLines ?? MAX_CHECK_OUTPUT_LINES;
  const spawnImpl = options.spawnImpl ?? spawn;

  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const child = spawnImpl(isWin ? 'cmd.exe' : 'sh', isWin ? ['/c', command] : ['-c', command], {
      cwd: workspaceDir,
      env: process.env,
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

    const finish = (result: LoopCheckResult) => {
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
