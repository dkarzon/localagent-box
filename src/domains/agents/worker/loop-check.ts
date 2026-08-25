import { spawn } from 'child_process';
import {
  MAX_WORKSPACE_COMMAND_OUTPUT_LINES,
  runWorkspaceCommand,
  type WorkspaceCommandResult,
} from './workspace-command';

export const DEFAULT_CHECK_COMMAND_TIMEOUT_MS = 120_000;
export const MAX_CHECK_OUTPUT_LINES = MAX_WORKSPACE_COMMAND_OUTPUT_LINES;
export { tailOutputLines } from './workspace-command';

export type LoopCheckResult = WorkspaceCommandResult;

export interface RunLoopCheckCommandOptions {
  timeoutMs?: number;
  maxOutputLines?: number;
  spawnImpl?: typeof spawn;
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
 * Thin wrapper around the shared `runWorkspaceCommand`
 * (see `workspace-command.ts`) so new callers (e.g. workspace bootstrap)
 * reuse the same runner.
 */
export function runLoopCheckCommand(
  workspaceDir: string,
  command: string,
  options: RunLoopCheckCommandOptions = {},
): Promise<LoopCheckResult> {
  return runWorkspaceCommand(workspaceDir, command, options);
}
