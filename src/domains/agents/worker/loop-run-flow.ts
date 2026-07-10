import { buildOpenCodePrompt, buildModelRefFromId, parseTimeoutMs } from '../../../integrations/opencode/runner';
import {
  startOpenCodeLoopSession,
  type OpenCodeLoopSessionHandle,
} from '../../../integrations/opencode/session-orchestrator';
import { buildLoopState } from '../../../lib/loop-state';
import type { AgentLoopState, AgentStatus, LoopVerb } from '../../../types';
import {
  appendLog,
  emitLoopIterationEnd,
  emitLoopStepEnd,
  emitLoopStepStart,
  getInboxPath,
  InboxReader,
  readAgentLoopFinishRequested,
  updateAgentRecord,
} from './agent-state-writer';
import {
  interpolateStepPrompt,
  loadLoopConfig,
  parseCompletionSignal,
} from './loop-config';
import { resolveLoopStepModel } from './loop-model';
import { loadRepoConfig } from './repo-config';
import type { RepoPromptOverrides } from '../../../types';
import {
  logOpenCodeRunContext,
  resolveAutoApprovePermissions,
  resolveBatchCompletionStatus,
  resolveBatchFailureMessage,
  resolveRunConfig,
} from './batch-run-flow';
import { finalizeGitChanges, captureGitStatusCheckpoint } from './workspace-setup';
import type { WorkerContext } from './worker-context';

function isFinishRequested(
  agentsStore: WorkerContext['agentsStore'],
  agentId: string,
  inboxReader: InboxReader,
): boolean {
  if (readAgentLoopFinishRequested(agentsStore, agentId)) {
    return true;
  }
  return inboxReader.pollFinishOnly();
}

function patchLoopState(
  status: AgentStatus,
  base: AgentLoopState,
  overrides: Partial<AgentLoopState>,
): AgentLoopState {
  return buildLoopState(status, { ...base, ...overrides });
}

type LoopStepExit =
  | { kind: 'continue'; reflectText?: string | null }
  | { kind: 'complete' }
  | { kind: 'finish' }
  | { kind: 'cancelled' }
  | { kind: 'timeout' }
  | { kind: 'failed'; pushOnFailure: boolean; failureMessage?: string };

interface RunLoopStepParams {
  session: OpenCodeLoopSessionHandle;
  loopState: AgentLoopState;
  loopConfig: { completionMarker: string };
  job: WorkerContext['job'];
  config: WorkerContext['config'];
  agentsStore: WorkerContext['agentsStore'];
  gitService: WorkerContext['gitService'];
  logPath: string;
  inboxReader: InboxReader;
  iteration: number;
  stepIndex: number;
  verb: LoopVerb;
  promptTemplate: string;
  repoPromptOverrides?: RepoPromptOverrides;
  /** REFLECT output from the previous iteration, injected into the first step of a rotated session. */
  previousIterationSummary?: string;
}

async function runLoopStep(params: RunLoopStepParams): Promise<{
  exit: LoopStepExit;
  loopState: AgentLoopState;
  resolvedModel: string | null;
}> {
  const {
    session,
    loopState: baseLoopState,
    loopConfig,
    job,
    config,
    agentsStore,
    logPath,
    inboxReader,
    iteration,
    stepIndex,
    verb,
    promptTemplate,
    repoPromptOverrides,
  } = params;

  let loopState = patchLoopState('processing', baseLoopState, {
    iteration,
    stepIndex,
    currentVerb: verb,
  });
  updateAgentRecord(agentsStore, job.agentId, { loop: loopState });

  const modelId = resolveLoopStepModel(verb, config, job);
  emitLoopStepStart(
    session.eventWriter,
    { iteration, stepIndex, verb, model: modelId },
    session.sessionId,
  );

  const stepModelRef = buildModelRefFromId(config, modelId);
  appendLog(
    logPath,
    `Loop step start: iteration=${iteration} step=${stepIndex} verb=${verb} model=${modelId ?? 'default'}`,
  );

  const interpolated = interpolateStepPrompt(promptTemplate, {
    goal: job.prompt,
    iteration,
    completionMarker: loopConfig.completionMarker,
  });
  const conversationText = params.previousIterationSummary
    ? `${interpolated}\n\n## Previous iteration summary\n${params.previousIterationSummary}`
    : interpolated;
  const promptText = buildOpenCodePrompt(
    conversationText,
    job.systemPrompt,
    'loop',
    loopConfig.completionMarker,
    repoPromptOverrides,
    config.systemPrompt,
  );

  const turnResult = await session.runTurn({
    conversationText,
    promptText,
    ...(stepModelRef ? { model: stepModelRef } : {}),
  });

  const checkpointGitStatus = () =>
    captureGitStatusCheckpoint({
      gitService: params.gitService,
      workspaceDir: job.workspaceDir,
      logPath,
      agentsStore: params.agentsStore,
      agentId: job.agentId,
    });

  if (turnResult.outcome === 'cancelled') {
    await checkpointGitStatus();
    emitLoopStepEnd(session.eventWriter, { iteration, stepIndex, verb }, session.sessionId);
    return { exit: { kind: 'cancelled' }, loopState, resolvedModel: modelId };
  }

  if (turnResult.outcome === 'timeout') {
    await checkpointGitStatus();
    emitLoopStepEnd(session.eventWriter, { iteration, stepIndex, verb }, session.sessionId);
    return { exit: { kind: 'timeout' }, loopState, resolvedModel: modelId };
  }

  if (turnResult.outcome === 'failed') {
    await checkpointGitStatus();
    emitLoopStepEnd(session.eventWriter, { iteration, stepIndex, verb }, session.sessionId);
    return {
      exit: {
        kind: 'failed',
        pushOnFailure: job.pushOnFailure,
        failureMessage: turnResult.failureMessage,
      },
      loopState,
      resolvedModel: modelId,
    };
  }

  const completionSignal =
    (verb === 'REFLECT' || verb === 'OBSERVE') &&
    parseCompletionSignal(turnResult.assistantText, loopConfig.completionMarker, interpolated);

  const reflectText = verb === 'REFLECT' ? turnResult.assistantText : null;

  await checkpointGitStatus();
  emitLoopStepEnd(
    session.eventWriter,
    { iteration, stepIndex, verb, completionSignal: completionSignal || undefined },
    session.sessionId,
  );
  appendLog(logPath, `Loop step end: iteration=${iteration} step=${stepIndex} verb=${verb}`);

  if (isFinishRequested(agentsStore, job.agentId, inboxReader)) {
    loopState = patchLoopState('processing', loopState, { finishRequested: true });
    updateAgentRecord(agentsStore, job.agentId, { loop: loopState });
    appendLog(logPath, 'Finish requested — completing after current step');
    return { exit: { kind: 'finish' }, loopState, resolvedModel: modelId };
  }

  if (completionSignal) {
    appendLog(logPath, `Loop completion signal detected on iteration ${iteration}`);
    return { exit: { kind: 'complete' }, loopState, resolvedModel: modelId };
  }

  return { exit: { kind: 'continue', reflectText }, loopState, resolvedModel: modelId };
}

export async function runLoopJob(ctx: WorkerContext): Promise<void> {
  const { job, logPath, config, agentsStore, gitService, githubApp } = ctx;
  const repo = ctx.repo;
  if (!repo) {
    throw new Error('Worker repository is not initialized');
  }

  appendLog(logPath, 'Running OpenCode (loop) via serve…');
  appendLog(logPath, `Goal: ${job.prompt}`);

  let loadedConfig;
  try {
    loadedConfig = loadLoopConfig(job.workspaceDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load loop config: ${message}`);
  }

  const { config: loopConfig, configSource } = loadedConfig;
  const repoPromptOverrides = loadRepoConfig(job.workspaceDir);
  const hasInitialPlan = Boolean(loopConfig.initialPlanPrompt?.trim());
  appendLog(
    logPath,
    `Loop config: source=${configSource}, maxIterations=${loopConfig.maxIterations}, steps=${loopConfig.steps.length}, initialPlan=${hasInitialPlan}`,
  );
  const initialLoopState = buildLoopState('processing', {
    iteration: hasInitialPlan ? 0 : 1,
    stepIndex: 0,
    currentVerb: hasInitialPlan ? 'INITIAL_PLAN' : (loopConfig.steps[0]?.verb ?? 'OBSERVE'),
    stepsInIteration: loopConfig.steps.length,
    maxIterations: loopConfig.maxIterations,
    completionMarker: loopConfig.completionMarker,
    finishRequested: false,
    configSource,
    effectiveSteps: loopConfig.steps,
  });

  updateAgentRecord(agentsStore, job.agentId, {
    mode: 'loop',
    status: 'processing',
    loop: initialLoopState,
  });

  const autoApprovePermissions = resolveAutoApprovePermissions(config, job, 'loop');
  appendLog(
    logPath,
    autoApprovePermissions
      ? 'Tool permissions: auto-approve enabled'
      : 'Tool permissions: auto-approve disabled',
  );

  logOpenCodeRunContext(logPath, {
    config: resolveRunConfig(config, job),
    job,
    timeoutMs: parseTimeoutMs(job.agentTimeoutMs),
  });

  const inboxReader = new InboxReader(getInboxPath(job));
  let session = await startOpenCodeLoopSession({ ctx, autoApprovePermissions });

  let loopState = initialLoopState;
  let exitReason: 'complete' | 'finish' | 'max_iterations' | 'timeout' | 'cancelled' | 'failed' =
    'max_iterations';
  const modelsUsed = new Set<string>();
  let opencodeSuccess = false;
  let lastReflectText: string | null = null;

  const sharedStepParams = {
    session,
    loopConfig,
    job,
    config,
    agentsStore,
    gitService,
    logPath,
    inboxReader,
    repoPromptOverrides: repoPromptOverrides ?? undefined,
  };

  const applyStepExit = (
    exit: LoopStepExit,
  ): { action: 'continue' | 'break' | 'return'; reflectText?: string | null } => {
    if (exit.kind === 'cancelled') {
      exitReason = 'cancelled';
      return { action: 'return' };
    }
    if (exit.kind === 'timeout') {
      exitReason = 'timeout';
      throw new Error(
        `Loop timed out after ${Math.round(parseTimeoutMs(job.agentTimeoutMs) / 1000)}s`,
      );
    }
    if (exit.kind === 'failed') {
      exitReason = 'failed';
      if (!exit.pushOnFailure) {
        throw new Error(exit.failureMessage || 'OpenCode session failed');
      }
      return { action: 'break' };
    }
    if (exit.kind === 'finish') {
      exitReason = 'finish';
      return { action: 'break' };
    }
    if (exit.kind === 'complete') {
      exitReason = 'complete';
      return { action: 'break' };
    }
    return { action: 'continue', reflectText: exit.reflectText };
  };

  try {
    let harnessDone = false;

    const runStepAndTrack = async (stepParams: Parameters<typeof runLoopStep>[0]) => {
      const result = await runLoopStep(stepParams);
      if (result.resolvedModel) modelsUsed.add(result.resolvedModel);
      return result;
    };

    if (hasInitialPlan && loopConfig.initialPlanPrompt) {
      const initialResult = await runStepAndTrack({
        ...sharedStepParams,
        loopState,
        iteration: 0,
        stepIndex: 0,
        verb: 'INITIAL_PLAN',
        promptTemplate: loopConfig.initialPlanPrompt,
      });
      loopState = initialResult.loopState;
      const initialExit = applyStepExit(initialResult.exit);
      if (initialExit.action === 'return') {
        return;
      }
      if (initialExit.action === 'break') {
        harnessDone = true;
      }
    }

    if (!harnessDone) {
      outer: for (let iteration = 1; iteration <= loopConfig.maxIterations; iteration += 1) {
        // Start each iteration in a fresh session to prevent conversation history from
        // accumulating across all loop steps. The REFLECT summary is passed to the first
        // step so the model retains context without replaying all prior turns.
        if (iteration > 1 || hasInitialPlan) {
          await session.rotateSession();
          appendLog(logPath, `OpenCode session rotated for iteration ${iteration} (fresh context)`);
        }

        let iterationCompleted = false;

        for (let stepIndex = 0; stepIndex < loopConfig.steps.length; stepIndex += 1) {
          const step = loopConfig.steps[stepIndex];
          const stepResult = await runStepAndTrack({
            ...sharedStepParams,
            loopState,
            iteration,
            stepIndex,
            verb: step.verb,
            promptTemplate: step.prompt,
            previousIterationSummary: stepIndex === 0 && iteration > 1 ? lastReflectText ?? undefined : undefined,
          });
          loopState = stepResult.loopState;

          const stepExit = applyStepExit(stepResult.exit);
          if (stepExit.reflectText) {
            lastReflectText = stepExit.reflectText;
          }
          if (stepExit.action === 'return') {
            return;
          }
          if (stepExit.action === 'break') {
            if (stepResult.exit.kind === 'complete') {
              iterationCompleted = true;
              emitLoopIterationEnd(
                session.eventWriter,
                { iteration, completed: true },
                session.sessionId,
              );
            }
            break outer;
          }
        }

        emitLoopIterationEnd(
          session.eventWriter,
          { iteration, completed: iterationCompleted },
          session.sessionId,
        );
        appendLog(logPath, `Loop iteration ${iteration} ended without completion signal`);
      }
    }

    if (exitReason === 'max_iterations') {
      appendLog(
        logPath,
        `Loop reached maxIterations (${loopConfig.maxIterations}) without ${loopConfig.completionMarker}: true`,
      );
      if (lastReflectText) {
        appendLog(logPath, `Last REFLECT output preview: ${lastReflectText.slice(0, 200)}`);
      }
      throw new Error(
        `Loop reached max iterations (${loopConfig.maxIterations}) without completion signal`,
      );
    }

    opencodeSuccess = exitReason === 'complete' || exitReason === 'finish';
  } finally {
    await session.dispose();
  }

  updateAgentRecord(agentsStore, job.agentId, {
    status: 'completing',
    lastActivityAt: new Date().toISOString(),
  });

  const shouldCommit = opencodeSuccess || job.pushOnFailure;
  if (!shouldCommit) {
    throw new Error('OpenCode loop failed');
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

  const modelsUsedArray = Array.from(modelsUsed);
  if (modelsUsedArray.length > 0) {
    appendLog(logPath, `Models used during loop run: ${modelsUsedArray.join(', ')}`);
  }

  updateAgentRecord(agentsStore, job.agentId, {
    status: 'completed',
    finishedAt,
    branch: job.agentBranch,
    commitSha: gitResult.commitSha,
    pushed: gitResult.pushed,
    filesChanged: gitResult.filesChanged,
    modelsUsed: modelsUsedArray.length > 0 ? modelsUsedArray : null,
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
    `Loop agent completed — ${gitResult.filesChanged} file(s) changed, pushed=${gitResult.pushed}`,
  );
}
