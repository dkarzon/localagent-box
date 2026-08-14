import { spawn } from 'child_process';

export const DEFAULT_CHECK_COMMAND_TIMEOUT_MS = 120_000;
export const MAX_CHECK_OUTPUT_LINES = 50;

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
    });

    let combined = '';
    let timedOut = false;

    const appendChunk = (chunk: Buffer | string) => {
      combined += chunk.toString();
    };

    child.stdout?.on('data', appendChunk);
    child.stderr?.on('data', appendChunk);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      resolve({
        command,
        exitCode: 1,
        outputTail: tailOutputLines(message, maxOutputLines),
        timedOut: false,
        success: false,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const exitCode = timedOut ? 124 : (code ?? 1);
      resolve({
        command,
        exitCode,
        outputTail: tailOutputLines(combined, maxOutputLines),
        timedOut,
        success: !timedOut && exitCode === 0,
      });
    });
  });
}
