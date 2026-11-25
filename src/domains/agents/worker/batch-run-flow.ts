import {
  buildModelFlag,
  getOpencodeBin,
} from '../../../integrations/opencode/runner';
import {
  runSessionOrchestrator,
  type CompletedTurn,
  type TurnFollowUp,
} from '../../../integrations/opencode/session-orchestrator';
import type {
  AgentJob,
  AgentVerification,
  AppConfig,
  RepoEnvironmentConfig,
} from '../../../types';
import {
  appendLog,
  appendLogBlock,
  updateAgentRecord,
} from './agent-state-writer';
import { loadEnvironmentConfigFromBase } from './git-ref-files';
import { finalizeGitChanges } from './workspace-setup';
import type { WorkerContext } from './worker-context';
import { checkResultBlock, resolveVerificationSettings, runChecks } from './verification';

export function resolveRunConfig(config: AppConfig, job: AgentJob): AppConfig {
  if (job.model) {
    return { ...config, opencodeModel: job.model };
  }
  return config;
}

export function resolveAutoApprovePermissions(config: AppConfig, job: AgentJob): boolean {
  if (job.autoApprovePermissions !== undefined) {
    return job.autoApprovePermissions;
  }
  return config.batchAutoApprovePermissions !== false;
}

/**
 * Completion status once host verification is in play. A check failure is the
 * run's failure even when files changed, because the host — not the model —
 * decides whether the work is good. Machine failures are reported separately so
 * they are never mistaken for a code failure.
 */
export function resolveBatchCompletionStatus(options: {
  opencodeSuccess: boolean;
  pushOnFailure: boolean;
  filesChanged: number;
  verification?: AgentVerification;
}): 'completed' | 'failed' | 'failed_machine' {
  if (options.verification?.state === 'machine_failure') {
    return 'failed_machine';
  }
  if (options.verification?.state === 'failed') {
    return 'failed';
  }
  if (options.filesChanged > 0 && (options.opencodeSuccess || options.pushOnFailure)) {
    return 'completed';
  }
  return 'failed';
}

export function resolveBatchFailureMessage(options: {
  opencodeSuccess: boolean;
  pushOnFailure: boolean;
  filesChanged: number;
  verification?: AgentVerification;
}): string {
  const lastAttempt = options.verification?.attempts.at(-1);
  const failingCheck = lastAttempt?.checks.at(-1);

  if (options.verification?.state === 'machine_failure' && failingCheck) {
    return `Machine failure: ${lastAttempt?.machineReason ?? 'unknown'} in ${failingCheck.name}`;
  }
  if (options.verification?.state === 'failed' && failingCheck) {
    return `Checks failed: ${failingCheck.name} exit ${failingCheck.exitCode}`;
  }

  if (options.opencodeSuccess && options.filesChanged === 0) {
    return 'Batch run finished without file changes — the model may have returned an overview only';
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

/**
 * Check config comes from the base branch, never the working tree, so a run
 * cannot rewrite the checks it is verified under. The batch clone is
 * `--single-branch`, so the base branch ref is fetched first.
 */
async function loadCheckConfig(ctx: WorkerContext): Promise<RepoEnvironmentConfig | null> {
  const { job, logPath, gitService } = ctx;
  if (!job.checksBaseBranch) {
    return null;
  }

  const ref = await gitService.ensureRemoteRef(job.workspaceDir, job.checksBaseBranch);
  if (!ref.available) {
    appendLog(
      logPath,
      `Checks: base branch ${job.checksBaseBranch} could not be read (${ref.message || 'git fetch failed'})`,
    );
    return null;
  }
  if (ref.fetched) {
    appendLog(logPath, `Checks: fetched base branch ${job.checksBaseBranch} at depth 1`);
  }

  const result = await loadEnvironmentConfigFromBase(job.workspaceDir, job.checksBaseBranch);
  for (const note of result.notes) {
    appendLog(logPath, note);
  }
  return result.config;
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

  const autoApprovePermissions = resolveAutoApprovePermissions(config, job);
  appendLog(
    logPath,
    autoApprovePermissions
      ? 'Tool permissions: auto-approve enabled'
      : 'Tool permissions: auto-approve disabled',
  );

  const settings = resolveVerificationSettings(await loadCheckConfig(ctx));
  const verification: AgentVerification = {
    state: 'unverified',
    configSource: settings.configSource,
    maxRepairAttempts: settings.maxRepairAttempts,
    attempts: [],
  };

  if (settings.checks.length === 0) {
    appendLog(logPath, 'Checks: none configured — the run is recorded as unverified');
  } else {
    appendLog(
      logPath,
      `Checks: ${settings.checks.map((check) => check.name).join(', ')} ` +
        `(timeout ${settings.timeoutMs}ms, config from base branch ${job.checksBaseBranch})`,
    );
  }

  /**
   * Host verification after the task turn. Repair turns arrive in 1.2, so for
   * now a failing check ends the run with `null`.
   */
  async function onTurnComplete(turn: CompletedTurn): Promise<TurnFollowUp | null> {
    if (settings.checks.length === 0 || turn.index !== 0) {
      return null;
    }

    updateAgentRecord(agentsStore, job.agentId, {
      status: 'verifying',
      lastActivityAt: new Date().toISOString(),
    });

    const attempt = await runChecks(job.workspaceDir, settings.checks, {
      attempt: verification.attempts.length,
      timeoutMs: settings.timeoutMs,
      maxOutputLines: settings.maxOutputLines,
    });

    verification.attempts.push(attempt);
    verification.state = attempt.passed
      ? 'passed'
      : attempt.failureKind === 'machine'
        ? 'machine_failure'
        : 'failed';

    updateAgentRecord(agentsStore, job.agentId, { verification });

    const stoppedAt = attempt.checks.at(-1);
    appendLogBlock(
      logPath,
      `Verification attempt ${attempt.attempt} — ${attempt.passed
        ? 'all checks passed'
        : `stopped at ${stoppedAt?.name ?? 'unknown'} (${attempt.failureKind ?? 'code'})`}`,
      attempt.checks.map((run) => checkResultBlock(run, `Check ${run.name}`)).join('\n\n'),
    );

    return null;
  }

  let opencodeSuccess = false;
  try {
    const result = await runSessionOrchestrator({
      ctx,
      autoApprovePermissions,
      onTurnComplete,
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

  // A failed check still leaves the branch for a person to look at, so the
  // commit and push happen for those outcomes too.
  const verificationFailed =
    verification.state === 'failed' || verification.state === 'machine_failure';
  const shouldCommit = opencodeSuccess || job.pushOnFailure || verificationFailed;
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
    verification,
  });
  const failureMessage = status === 'completed'
    ? null
    : resolveBatchFailureMessage({
        opencodeSuccess,
        pushOnFailure: job.pushOnFailure,
        filesChanged: gitResult.filesChanged,
        verification,
      });

  updateAgentRecord(agentsStore, job.agentId, {
    status,
    finishedAt,
    branch: job.agentBranch,
    commitSha: gitResult.commitSha,
    pushed: gitResult.pushed,
    filesChanged: gitResult.filesChanged,
    error: failureMessage,
    verification,
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

  if (failureMessage) {
    appendLog(logPath, failureMessage);
    throw new Error(failureMessage);
  }

  appendLog(
    logPath,
    `Agent completed — ${gitResult.filesChanged} file(s) changed, pushed=${gitResult.pushed}`,
  );
  if (gitResult.commitSha) {
    appendLog(logPath, `Commit: ${gitResult.commitSha}`);
  }
}
