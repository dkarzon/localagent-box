import {
  buildModelFlag,
  getOpencodeBin,
} from '../../../integrations/opencode/runner';
import { runSessionOrchestrator } from '../../../integrations/opencode/session-orchestrator';
import type { AgentJob, AgentMode, AppConfig } from '../../../types';
import {
  appendLog,
  updateAgentRecord,
} from './agent-state-writer';
import { finalizeGitChanges } from './workspace-setup';
import type { WorkerContext } from './worker-context';

export function resolveRunConfig(config: AppConfig, job: AgentJob): AppConfig {
  if (job.model) {
    return { ...config, opencodeModel: job.model };
  }
  return config;
}

export function resolveAutoApprovePermissions(
  config: AppConfig,
  job: AgentJob,
  mode: AgentMode,
): boolean {
  if (job.autoApprovePermissions !== undefined) {
    return job.autoApprovePermissions;
  }
  if (mode === 'batch') {
    return config.batchAutoApprovePermissions !== false;
  }
  if (mode === 'loop') {
    return config.loopAutoApprovePermissions !== false;
  }
  return config.interactiveAutoApprovePermissions === true;
}

/** Batch agents must produce committable file changes — overview-only runs are failures. */
export function resolveBatchCompletionStatus(options: {
  opencodeSuccess: boolean;
  pushOnFailure: boolean;
  filesChanged: number;
}): 'completed' | 'failed' {
  if (options.filesChanged > 0 && (options.opencodeSuccess || options.pushOnFailure)) {
    return 'completed';
  }
  return 'failed';
}

export function resolveBatchFailureMessage(options: {
  opencodeSuccess: boolean;
  pushOnFailure: boolean;
  filesChanged: number;
}): string {
  if (options.opencodeSuccess && options.filesChanged === 0) {
    return 'Batch run finished without file changes — the model may have returned an overview only';
  }
  if (options.pushOnFailure && options.filesChanged === 0) {
    return 'OpenCode failed with no committable changes';
  }
  return 'OpenCode failed with no committable changes';
}

export function logOpenCodeRunContext(
  logPath: string,
  { config, job, timeoutMs }: { config: AppConfig; job: AgentJob; timeoutMs: number },
): void {
  const model = buildModelFlag(resolveRunConfig(config, job));
  appendLog(logPath, `OpenCode binary: ${getOpencodeBin()}`);
  appendLog(logPath, `OpenCode model: ${model || '(default)'}`);
  appendLog(logPath, `OpenCode timeout: ${Math.round(timeoutMs / 1000)}s`);
  appendLog(logPath, `OpenCode working directory: ${job.workspaceDir}`);
}

export async function runBatchJob(ctx: WorkerContext): Promise<void> {
  const { job, logPath, config, agentsStore, gitService, githubApp } = ctx;
  const repo = ctx.repo;
  if (!repo) {
    throw new Error('Worker repository is not initialized');
  }

  appendLog(logPath, 'Running OpenCode (batch) via serve…');
  appendLog(logPath, `Prompt: ${job.prompt}`);
  if (job.systemPrompt) {
    appendLog(logPath, 'Using custom system prompt');
  }

  const autoApprovePermissions = resolveAutoApprovePermissions(config, job, 'batch');
  appendLog(
    logPath,
    autoApprovePermissions
      ? 'Tool permissions: auto-approve enabled'
      : 'Tool permissions: auto-approve disabled',
  );

  let opencodeSuccess = false;
  try {
    const result = await runSessionOrchestrator({
      mode: 'batch',
      ctx,
      autoApprovePermissions,
    });

    if (result.outcome === 'cancelled') {
      return;
    }

    if (result.outcome === 'failed') {
      appendLog(logPath, result.failureMessage || 'OpenCode session failed');
      if (!job.pushOnFailure) {
        throw new Error(result.failureMessage || 'OpenCode session failed');
      }
    } else if (result.outcome === 'turn_complete') {
      opencodeSuccess = true;
      appendLog(logPath, 'OpenCode completed successfully');
    } else {
      throw new Error('OpenCode session ended unexpectedly');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendLog(logPath, `OpenCode error: ${message}`);
    if (!job.pushOnFailure) {
      throw err;
    }
  }

  updateAgentRecord(agentsStore, job.agentId, {
    status: 'completing',
    lastActivityAt: new Date().toISOString(),
  });

  const shouldCommit = opencodeSuccess || job.pushOnFailure;
  if (!shouldCommit) {
    throw new Error('OpenCode failed');
  }

  const gitResult = await finalizeGitChanges({
    gitService,
    githubApp,
    config,
    repo,
    job,
    logPath,
    allowCommit: shouldCommit,
  });

  const finishedAt = new Date().toISOString();
  const warnings: string[] = [];

  if (!opencodeSuccess && job.pushOnFailure) {
    warnings.push('OpenCode failed but changes were committed per pushOnFailure');
  }
  if (gitResult.filesChanged === 0) {
    warnings.push('No file changes to commit');
  }

  const status = resolveBatchCompletionStatus({
    opencodeSuccess,
    pushOnFailure: job.pushOnFailure,
    filesChanged: gitResult.filesChanged,
  });

  if (status === 'failed') {
    throw new Error(
      resolveBatchFailureMessage({
        opencodeSuccess,
        pushOnFailure: job.pushOnFailure,
        filesChanged: gitResult.filesChanged,
      }),
    );
  }

  updateAgentRecord(agentsStore, job.agentId, {
    status: 'completed',
    finishedAt,
    branch: job.agentBranch,
    commitSha: gitResult.commitSha,
    pushed: gitResult.pushed,
    filesChanged: gitResult.filesChanged,
    error: null,
    result: {
      branch: job.agentBranch,
      baseBranch: job.baseBranch,
      workspaceId: job.workspaceId,
      commitSha: gitResult.commitSha,
      pushed: gitResult.pushed,
      filesChanged: gitResult.filesChanged,
      warning: warnings.length ? warnings.join('; ') : null,
      opencodeSuccess,
    },
  });

  appendLog(
    logPath,
    `Agent completed — ${gitResult.filesChanged} file(s) changed, pushed=${gitResult.pushed}`,
  );
  if (gitResult.commitSha) {
    appendLog(logPath, `Commit: ${gitResult.commitSha}`);
  }
}
