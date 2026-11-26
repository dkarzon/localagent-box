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
  CreateOpenCodeSessionRunnerOptions,
  OpenCodeSessionRunner,
} from '../../../integrations/opencode/session-runner';
import type {
  Agent,
  AgentJob,
  AgentVerification,
  AppConfig,
  RepoEnvironmentConfig,
} from '../../../types';
import {
  appendLog,
  appendLogBlock,
  readAgentStatus,
  updateAgentRecord,
} from './agent-state-writer';
import { loadEnvironmentConfigFromBase } from './git-ref-files';
import { finalizeGitChanges } from './workspace-setup';
import type { WorkerContext } from './worker-context';
import {
  buildRepairPrompt,
  checkResultBlock,
  resolveVerificationSettings,
  runChecks,
} from './verification';

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
 * they are never mistaken for a code failure, and a code failure that used up its
 * repair attempts becomes `needs_attention` for a person to look at (v1 1.2).
 */
export function resolveBatchCompletionStatus(options: {
  opencodeSuccess: boolean;
  pushOnFailure: boolean;
  filesChanged: number;
  verification?: AgentVerification;
}): 'completed' | 'failed' | 'failed_machine' | 'needs_attention' {
  if (options.verification?.state === 'machine_failure') {
    return 'failed_machine';
  }
  if (options.verification?.state === 'failed') {
    return 'needs_attention';
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
    const repairs = (lastAttempt?.attempt ?? 0);
    const base = `Checks failed: ${failingCheck.name} exit ${failingCheck.exitCode}`;
    return repairs > 0 ? `${base} after ${repairs} repair attempt(s)` : base;
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

/**
 * Test seams for a batch run. Every host-owned boundary a repair-loop test needs is
 * injectable, so a test can script outcomes without a real workspace or session.
 */
export interface BatchRunDeps {
  /** Check config from the base branch; defaults to reading it with git. */
  loadCheckConfig?: (ctx: WorkerContext) => Promise<RepoEnvironmentConfig | null>;
  /** Host-run checks; defaults to `runChecks`. */
  runChecks?: typeof runChecks;
  /** Session runner handed to the orchestrator (see 1.0); defaults to the real one. */
  createRunner?: (options: CreateOpenCodeSessionRunnerOptions) => OpenCodeSessionRunner;
}

export async function runBatchJob(ctx: WorkerContext, deps: BatchRunDeps = {}): Promise<void> {
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

  const settings = resolveVerificationSettings(
    await (deps.loadCheckConfig ?? loadCheckConfig)(ctx),
  );
  const verification: AgentVerification = {
    state: 'unverified',
    configSource: settings.configSource,
    maxRepairAttempts: settings.maxRepairAttempts,
    draftPrOnFailure: settings.draftPrOnFailure,
    attempts: [],
  };

  if (settings.checks.length === 0) {
    appendLog(logPath, 'Checks: none configured — the run is recorded as unverified');
  } else {
    appendLog(
      logPath,
      `Checks: ${settings.checks.map((check) => check.name).join(', ')} ` +
        `(timeout ${settings.timeoutMs}ms, repair attempts ${settings.maxRepairAttempts}, ` +
        `config from base branch ${job.checksBaseBranch})`,
    );
  }

  const persistVerification = (patch: Partial<Agent> = {}) =>
    updateAgentRecord(agentsStore, job.agentId, {
      ...patch,
      verification,
      lastActivityAt: new Date().toISOString(),
    });

  /**
   * Host verification after each turn. A code failure earns a repair turn while
   * attempts remain; a machine failure stops immediately, and exhausted attempts
   * end the run as needs_attention. The poll loop checks cancellation and the
   * timeout before calling this, so no repair turn runs past either.
   */
  async function onTurnComplete(turn: CompletedTurn): Promise<TurnFollowUp | null> {
    if (settings.checks.length === 0) {
      return null;
    }

    if (readAgentStatus(agentsStore, job.agentId) === 'cancelled') {
      appendLog(logPath, `Checks skipped after turn ${turn.index} — the run was cancelled`);
      return null;
    }

    persistVerification({ status: 'verifying' });
    const attempt = await (deps.runChecks ?? runChecks)(
      job.workspaceDir,
      settings.checks,
      {
        attempt: verification.attempts.length,
        timeoutMs: settings.timeoutMs,
        maxOutputLines: settings.maxOutputLines,
      },
    );
    verification.attempts.push(attempt);

    const failingCheck = attempt.checks.at(-1);
    appendLogBlock(
      logPath,
      `Verification attempt ${attempt.attempt} — ${attempt.passed
        ? 'all checks passed'
        : `stopped at ${failingCheck?.name ?? 'unknown'} (${attempt.failureKind ?? 'code'})`}`,
      attempt.checks.map((run) => checkResultBlock(run, `Check ${run.name}`)).join('\n\n'),
    );

    if (attempt.passed) {
      verification.state = 'passed';
      persistVerification();
      return null;
    }

    if (attempt.failureKind === 'machine') {
      verification.state = 'machine_failure';
      persistVerification();
      appendLog(
        logPath,
        `Machine failure (${attempt.machineReason ?? 'unknown'}) in ${failingCheck?.name ?? 'a check'} — ` +
          'no repair turn; the code is not the problem',
      );
      return null;
    }

    if (!failingCheck) {
      return null;
    }

    verification.state = 'failed';
    const repairsUsed = verification.attempts.length - 1;
    if (repairsUsed >= settings.maxRepairAttempts) {
      persistVerification();
      appendLog(
        logPath,
        `Repair attempts exhausted (${repairsUsed} of ${settings.maxRepairAttempts}) — ` +
          'the run needs attention',
      );
      return null;
    }

    const repairAttempt = repairsUsed + 1;
    persistVerification({ status: 'repairing', repairAttempt });
    appendLog(
      logPath,
      `Repair attempt ${repairAttempt} of ${settings.maxRepairAttempts} — sending the failing check back to the model`,
    );
    return {
      followUp: buildRepairPrompt({
        attempt: repairAttempt,
        max: settings.maxRepairAttempts,
        failingCheck,
      }),
    };
  }

  let opencodeSuccess = false;
  try {
    const result = await runSessionOrchestrator({
      ctx,
      autoApprovePermissions,
      onTurnComplete,
      ...(deps.createRunner ? { createRunner: deps.createRunner } : {}),
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
