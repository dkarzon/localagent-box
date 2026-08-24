import type { Agent, AgentBootstrapState } from '../../../types';
import type { JsonStore } from '../../../lib/json-store';
import { appendLog, appendLogBlock, updateAgentRecord } from './agent-state-writer';
import { environmentConfigRelative, loadEnvironmentConfig } from './environment-config';
import { runWorkspaceCommand } from './workspace-command';

/** Default timeout applied to a repo's setup command (10 min). */
export const DEFAULT_SETUP_TIMEOUT_MS = 600_000;

export interface RunWorkspaceBootstrapOptions {
  workspaceDir: string;
  logPath: string;
  agentId: string;
  agentsStore: JsonStore<{ agents: Agent[] }>;
  /** Injectable for tests; defaults to the shared `runWorkspaceCommand`. */
  runCommand?: typeof runWorkspaceCommand;
}

/**
 * Host-run workspace bootstrap: load `.localagent-box/environment.json`, run the
 * repo's setup command before the agent starts, and record the outcome on the
 * agent record plus in the worker log.
 *
 * No-op (skipped) when the repo declares no environment config or no
 * `setup.command`. Throws when the setup command fails with `failOnError` left
 * at its default (`true`); caller is expected to fail the agent start.
 */
export async function runWorkspaceBootstrap(
  options: RunWorkspaceBootstrapOptions,
): Promise<AgentBootstrapState> {
  const { workspaceDir, logPath, agentId, agentsStore } = options;
  const runCommand = options.runCommand ?? runWorkspaceCommand;

  const envConfig = loadEnvironmentConfig(workspaceDir);
  const setup = envConfig?.setup;
  if (!setup) {
    return { status: 'skipped' };
  }
  const { command, timeoutMs, failOnError } = setup;

  appendLog(logPath, 'Running workspace bootstrap…');
  appendLog(logPath, `${environmentConfigRelative} command: ${command}`);
  updateAgentRecord(agentsStore, agentId, {
    bootstrap: { status: 'running', command },
  });

  const timeoutMsToUse = timeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS;
  const startedAt = Date.now();
  const result = await runCommand(workspaceDir, command, { timeoutMs: timeoutMsToUse });
  const durationMs = Date.now() - startedAt;

  if (result.success) {
    appendLog(logPath, `Workspace bootstrap completed in ${durationMs}ms (exit code ${result.exitCode})`);
    appendLogBlock(logPath, 'Workspace bootstrap output:', result.outputTail);
    const state: AgentBootstrapState = {
      status: 'completed',
      command,
      durationMs,
      exitCode: result.exitCode,
      outputTail: result.outputTail,
    };
    updateAgentRecord(agentsStore, agentId, { bootstrap: state });
    return state;
  }

  const exitCode = result.exitCode;
  const outputTail = result.outputTail;
  if (result.timedOut) {
    appendLog(logPath, `Workspace bootstrap timed out after ${durationMs}ms (exit code ${exitCode})`);
  } else {
    appendLog(logPath, `Workspace bootstrap failed with exit code ${exitCode} after ${durationMs}ms`);
  }
  appendLogBlock(logPath, 'Workspace bootstrap output:', outputTail);

  const error = result.timedOut
    ? `Bootstrap timed out: \`${command}\` (timeout ${timeoutMsToUse}ms)`
    : `Bootstrap failed: \`${command}\` exited ${exitCode}`;
  const failedState: AgentBootstrapState = {
    status: 'failed',
    command,
    durationMs,
    exitCode,
    outputTail,
    error,
  };

  if (failOnError === false) {
    appendLog(logPath, 'Workspace bootstrap failed but failOnError=false — continuing');
    updateAgentRecord(agentsStore, agentId, { bootstrap: failedState });
    return failedState;
  }

  updateAgentRecord(agentsStore, agentId, { bootstrap: failedState });
  throw new Error(`${error}\n${outputTail}`);
}
