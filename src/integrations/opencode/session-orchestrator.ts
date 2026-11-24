import fs from 'fs';
import path from 'path';
import { getServerEnv } from '../../config/env';
import {
  createOpenCodeConfigService,
  excludeWorkspaceInfrastructureFromGit,
  isGemmaThinkingModel,
} from '../../services/opencode-config';
import { resolveModelContextLengths } from '../../services/ollama-probe';
import type { NormalizedTool } from '../../lib/tool-event';
import { computeModelCost, hasModelTokenCost, resolveModelTokenCost } from '../../lib/model-cost';
import {
  extractAssistantTextFromPayload,
  mergeAssistantText,
} from '../../lib/assistant-text';
import {
  appendConversation,
  appendLog,
  appendLogBlock,
  EventWriter,
  getAgentDir,
  getEventsPath,
  readAgentRecord,
  readAgentStatus,
  updateAgentRecord,
} from '../../domains/agents/worker/agent-state-writer';
import { logOpenCodeRunContext, resolveRunConfig } from '../../domains/agents/worker/batch-run-flow';
import { loadRepoConfig } from '../../domains/agents/worker/repo-config';
import type { WorkerContext } from '../../domains/agents/worker/worker-context';
import type {
  Agent,
  AgentStatus,
  AgentTokenUsage,
  AppConfig,
  ModelTokenCosts,
} from '../../types';
import { createOpenCodeEventMapper } from './event-mapper';
import {
  buildModelRef,
  buildOpenCodePrompt,
  formatBootstrapSummaryBlock,
  isAgentRunTimedOut,
  parseTimeoutMs,
  resolveAgentRunStartedAtMs,
} from './runner';
import {
  createOpenCodeSessionRunner,
  getAgentOpenCodeConfigDir,
  isBatchTurnComplete,
  type OpenCodeServerEvent,
  type OpenCodeSessionRunner,
} from './session-runner';

export type SessionOrchestratorOutcome = 'cancelled' | 'failed' | 'turn_complete';

export interface SessionOrchestratorOptions {
  ctx: WorkerContext;
  /** PR2: merge permission allow block into per-agent opencode.json */
  autoApprovePermissions?: boolean;
}

export interface SessionOrchestratorResult {
  outcome: SessionOrchestratorOutcome;
  sessionId: string;
  failureMessage?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface MessageTokenInfo {
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache_read?: number;
    cache_write?: number;
  };
  cost?: number;
  model?: string;
}

/**
 * Extract token counts and cost from an assistant.message payload's `info` field.
 * A positive provider-reported cost wins. Otherwise (e.g. Ollama reports 0) the cost
 * is computed from the rates configured for that exact model; models without an
 * entry cost 0. Returns null if no token data is present.
 */
export function extractMessageTokenUsage(
  payload: Record<string, unknown>,
  modelTokenCosts: ModelTokenCosts,
): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  estimatedCost: boolean;
  model: string;
} | null {
  const msgInfo = payload.info as MessageTokenInfo | undefined;
  const tokens = msgInfo?.tokens;
  if (!tokens) {
    return null;
  }
  const usage = {
    input: typeof tokens.input === 'number' ? tokens.input : 0,
    output: typeof tokens.output === 'number' ? tokens.output : 0,
    cacheRead: typeof tokens.cache_read === 'number' ? tokens.cache_read : 0,
    cacheWrite: typeof tokens.cache_write === 'number' ? tokens.cache_write : 0,
  };
  const reasoning = typeof tokens.reasoning === 'number' ? tokens.reasoning : 0;
  const reportedCost = typeof msgInfo?.cost === 'number' && msgInfo.cost > 0 ? msgInfo.cost : 0;
  const model = typeof msgInfo?.model === 'string' ? msgInfo.model : '(unknown)';
  const rates = resolveModelTokenCost(modelTokenCosts, model);
  const estimated = reportedCost === 0 && rates !== null && hasModelTokenCost(rates);
  return {
    ...usage,
    cost: estimated && rates ? computeModelCost(rates, { ...usage, reasoning }) : reportedCost,
    estimatedCost: estimated,
    model,
  };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Assistant text produced by a batch turn: the streamed deltas merged with the
 * message snapshot, whichever is longer (a snapshot can arrive after the stream).
 * Reported per turn so the host can show what the model actually said.
 */
export function resolveTurnAssistantText(state: {
  lastAssistantText: string | null;
  streamedAssistantText: string;
}): string | null {
  const snapshot = state.lastAssistantText;
  const streamed = state.streamedAssistantText;
  if (!streamed) {
    return snapshot;
  }
  if (!snapshot) {
    return streamed;
  }
  return mergeAssistantText(streamed, snapshot);
}

/**
 * Unattended runs have no one to answer OpenCode: auto-approve permission
 * requests when enabled, and cancel forms (v2's question tool) so the turn never blocks.
 */
export function handleUnattendedRequest(
  ocEvent: OpenCodeServerEvent,
  runner: Pick<OpenCodeSessionRunner, 'replyPermission' | 'cancelForm'>,
  logPath: string,
  autoApprovePermissions: boolean,
): void {
  const props = ocEvent.properties;
  if (ocEvent.type === 'permission.asked' && autoApprovePermissions) {
    const requestId = typeof props.id === 'string' ? props.id : undefined;
    const sessionID = typeof props.sessionID === 'string' ? props.sessionID : undefined;
    if (requestId && sessionID) {
      void runner
        .replyPermission(sessionID, requestId, 'once')
        .then(() => appendLog(logPath, `OpenCode permission auto-approved: ${requestId}`))
        .catch((err) =>
          appendLog(logPath, `OpenCode permission auto-approve failed (${describeError(err)})`),
        );
    }
    return;
  }
  if (ocEvent.type === 'form.created') {
    const form = props.form as { id?: string; sessionID?: string; title?: string } | undefined;
    if (form?.id && form.sessionID) {
      void runner
        .cancelForm(
          form.sessionID,
          form.id,
          'Unattended run: no user is available to answer. Make a reasonable assumption and continue.',
        )
        .then(() => appendLog(logPath, `OpenCode form cancelled (unattended): ${form.title ?? form.id}`))
        .catch((err) => appendLog(logPath, `OpenCode form cancel failed (${describeError(err)})`));
    }
  }
}

function isCodegraphEnabled(): boolean {
  return getServerEnv().enableCodegraph;
}

function logCodegraphEnabled(logPath: string): void {
  appendLog(logPath, 'OpenCode MCP: codegraph enabled');
}

/** An unreachable server just yields no limits — OpenCode then uses its own defaults. */
async function resolveContextLengthsForRun(
  runConfig: AppConfig,
  logPath: string,
): Promise<Record<string, number>> {
  const lengths = await resolveModelContextLengths(runConfig);
  const entries = Object.entries(lengths);
  if (entries.length > 0) {
    appendLog(
      logPath,
      `OpenCode model limits from server: ${entries.map(([id, n]) => `${id}=${n}`).join(', ')}`,
    );
  }
  return lengths;
}

export async function runSessionOrchestrator(
  options: SessionOrchestratorOptions,
): Promise<SessionOrchestratorResult> {
  const { ctx } = options;
  const autoApprovePermissions = options.autoApprovePermissions ?? false;

  const { job, logPath, config, agentsStore } = ctx;
  const repoPromptOverrides = loadRepoConfig(job.workspaceDir);
  const agentDir = getAgentDir(job);
  const runConfig = resolveRunConfig(config, job);
  const modelRef = buildModelRef(runConfig);
  const eventWriter = new EventWriter(getEventsPath(job));
  fs.mkdirSync(agentDir, { recursive: true });

  const codegraph = isCodegraphEnabled();

  const perAgentConfig = createOpenCodeConfigService({
    configDir: getAgentOpenCodeConfigDir(agentDir),
  });
  perAgentConfig.writeOpenCodeConfig(runConfig, {
    autoApprovePermissions,
    codegraph,
    disableQuestionTool: true,
    modelContextLengths: await resolveContextLengthsForRun(runConfig, logPath),
  });
  const opencodeConfigPath = path.join(getAgentOpenCodeConfigDir(agentDir), 'opencode.json');
  appendLog(logPath, `OpenCode config written: ${opencodeConfigPath}`);
  if (codegraph) {
    logCodegraphEnabled(logPath);
  }
  appendLog(logPath, 'OpenCode tools: question disabled in opencode.json (unattended batch)');
  if (runConfig.opencodeModel && isGemmaThinkingModel(runConfig.opencodeModel)) {
    appendLog(
      logPath,
      `OpenCode model workaround: disabled Gemma thinking mode for ${runConfig.opencodeModel} (reasoning_effort=none) — see opencode#20995`,
    );
  }
  if (autoApprovePermissions) {
    appendLog(logPath, 'OpenCode permissions: auto-approve enabled in opencode.json');
  }
  excludeWorkspaceInfrastructureFromGit(job.workspaceDir);

  appendLog(logPath, 'Starting OpenCode session…');
  logOpenCodeRunContext(logPath, {
    config: runConfig,
    job,
    timeoutMs: parseTimeoutMs(job.agentTimeoutMs),
  });
  appendLog(logPath, `OpenCode agent dir: ${agentDir}`);

  const sessionRunner = createOpenCodeSessionRunner({
    cwd: job.workspaceDir,
    agentDir,
    onServerOutput: (chunk) => fs.appendFileSync(logPath, chunk),
    onDebugLog: (line) => appendLog(logPath, line),
  });

  let sessionId = '';
  let turnCount = 0;
  let sessionFailed = false;
  let failureMessage: string | null = null;
  const sessionStartedAt = resolveAgentRunStartedAtMs(
    readAgentRecord(agentsStore, job.agentId)?.startedAt,
  );
  const timeoutMs = parseTimeoutMs(job.agentTimeoutMs);
  let eventSubscription: { unsubscribe: () => void; ready: Promise<void> } | undefined;
  let seenBusySinceProcessing = false;
  let batchPromptBusySeen = false;
  const eventMapper = createOpenCodeEventMapper();
  let textDeltaEventCount = 0;
  let reasoningDeltaEventCount = 0;
  let textUpdatedEventCount = 0;
  let reasoningUpdatedEventCount = 0;
  let textDeltaEmittedCount = 0;
  let reasoningDeltaEmittedCount = 0;
  let lastTextDebugLogAt = 0;
  let loggedFirstTextDelta = false;
  let loggedReasoningOnlyWarning = false;
  let accumulatedStreamedTextLen = 0;
  let accumulatedStreamedText = '';

  // Cumulative token usage across all assistant messages in this session
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  let totalCost = 0;
  let costEstimated = false;
  let hasTokenUsage = false;

  const TEXT_DEBUG_LOG_TYPES = new Set([
    'message.part.delta',
    'message.part.updated',
    'message.updated',
    'session.error',
  ]);

  function logOpenCodeSseEvent(detail: string): void {
    appendLog(logPath, `OpenCode SSE: ${detail}`);
  }

  function maybeLogTextStreamingSummary(): void {
    const now = Date.now();
    if (now - lastTextDebugLogAt < 5000) {
      return;
    }
    lastTextDebugLogAt = now;
    appendLog(
      logPath,
      `OpenCode text stream summary: textDeltaEvents=${textDeltaEventCount} textDeltaEmitted=${textDeltaEmittedCount} textUpdatedEvents=${textUpdatedEventCount} reasoningDeltaEvents=${reasoningDeltaEventCount} reasoningDeltaEmitted=${reasoningDeltaEmittedCount} reasoningUpdatedEvents=${reasoningUpdatedEventCount}`,
    );
  }
  const sseLockedStatuses = new Set<AgentStatus>([
    'queued',
    'completing',
    'completed',
    'failed',
    'cancelled',
  ]);

  const handleOpenCodeEvent = (ocEvent: OpenCodeServerEvent) => {
    handleUnattendedRequest(ocEvent, sessionRunner, logPath, autoApprovePermissions);

    if (ocEvent.type === 'message.part.delta') {
      const field = ocEvent.properties.field;
      if (field === 'reasoning') {
        reasoningDeltaEventCount += 1;
      } else {
        textDeltaEventCount += 1;
        if (field && field !== 'text') {
          const delta = ocEvent.properties.delta;
          logOpenCodeSseEvent(
            `non-text delta field=${String(field)} partId=${String(ocEvent.properties.partID ?? '?')} deltaLen=${typeof delta === 'string' ? delta.length : 0}`,
          );
        }
      }
    } else if (ocEvent.type === 'message.part.updated') {
      const part = ocEvent.properties.part as { type?: string } | undefined;
      if (part?.type === 'text') {
        textUpdatedEventCount += 1;
      } else if (part?.type === 'reasoning') {
        reasoningUpdatedEventCount += 1;
      } else if (part?.type) {
        logOpenCodeSseEvent(`part.updated type=${part.type} partId=${String((part as { id?: string }).id ?? '?')}`);
      }
    }

    const { event: mapped, debug } = eventMapper.map(ocEvent, sessionId);

    const snapshotDebugSources = new Set([
      'updated-backfill',
      'updated-skip',
      'updated-reset',
      'reasoning-updated-backfill',
      'reasoning-updated-skip',
      'reasoning-updated-reset',
    ]);
    if (debug && snapshotDebugSources.has(debug.source ?? '')) {
      logOpenCodeSseEvent(
        `text part=${debug.partId ?? '?'} field=${debug.field ?? 'text'} source=${debug.source} prevLen=${debug.previousLen ?? 0} nextLen=${debug.nextLen ?? 0} emitLen=${debug.emittedLen ?? 0} preview=${JSON.stringify(debug.preview ?? '')}`,
      );
      if (debug.source === 'updated-reset' || debug.source === 'reasoning-updated-reset') {
        appendLog(
          logPath,
          `OpenCode SSE warning: ${debug.field ?? 'text'} snapshot reset (updated text did not extend previous snapshot — possible missed deltas)`,
        );
      }
      maybeLogTextStreamingSummary();
    } else if (debug?.source === 'delta' && debug.emittedLen) {
      textDeltaEmittedCount += 1;
      if (!loggedFirstTextDelta) {
        loggedFirstTextDelta = true;
        logOpenCodeSseEvent(
          `first text delta part=${debug.partId ?? '?'} emitLen=${debug.emittedLen} preview=${JSON.stringify(debug.preview ?? '')}`,
        );
      }
      maybeLogTextStreamingSummary();
    } else if (debug?.source === 'reasoning-delta' && debug.emittedLen) {
      reasoningDeltaEmittedCount += 1;
      if (!loggedReasoningOnlyWarning) {
        loggedReasoningOnlyWarning = true;
        appendLog(
          logPath,
          'OpenCode SSE warning: model output is streaming in reasoning field (Gemma thinking mode?) — content may be truncated unless reasoning_effort=none is set',
        );
      }
      maybeLogTextStreamingSummary();
    }

    if (!mapped && TEXT_DEBUG_LOG_TYPES.has(ocEvent.type)) {
      const part = ocEvent.properties.part as { type?: string; id?: string; text?: string } | undefined;
      const delta = ocEvent.properties.delta;
      logOpenCodeSseEvent(
        `unmapped type=${ocEvent.type} partType=${part?.type ?? '(none)'} partId=${part?.id ?? ocEvent.properties.partID ?? '(none)'} textLen=${typeof part?.text === 'string' ? part.text.length : 0} deltaLen=${typeof delta === 'string' ? delta.length : 0} field=${String(ocEvent.properties.field ?? '(none)')}`,
      );
    } else if (
      !mapped &&
      ocEvent.type !== 'server.connected' &&
      (ocEvent.type.startsWith('message.') || ocEvent.type.startsWith('permission.'))
    ) {
      logOpenCodeSseEvent(
        `ignored type=${ocEvent.type} keys=${Object.keys(ocEvent.properties).join(',') || '(none)'}`,
      );
    }

    if (!mapped) {
      return;
    }
    if (mapped.type === 'assistant.delta') {
      // Keep reasoning out of persisted conversation text; it often echoes the answer.
      if (mapped.payload.field !== 'reasoning') {
        const deltaText = mapped.payload.text;
        if (typeof deltaText === 'string') {
          accumulatedStreamedTextLen += deltaText.length;
          accumulatedStreamedText += deltaText;
        }
      }
    }
    eventWriter.write(mapped.type, mapped.payload, sessionId || undefined);
    if (mapped.type === 'assistant.message') {
      const info = mapped.payload.info as { role?: string } | undefined;
      const snapshot = extractAssistantTextFromPayload(mapped.payload);
      const assistantText = mergeAssistantText(accumulatedStreamedText, snapshot).trim();
      const parts = mapped.payload.parts as Array<{ type?: string; text?: string }> | undefined;
      const textParts = Array.isArray(parts)
        ? parts.filter(
            (part) =>
              (part.type === 'text' || part.type === 'reasoning') &&
              typeof part.text === 'string',
          )
        : [];
      const totalTextLen = textParts.reduce((sum, part) => sum + (part.text?.length ?? 0), 0);
      const preview = textParts.map((part) => part.text).join('').slice(0, 120);
      logOpenCodeSseEvent(
        `assistant.message role=${info?.role ?? '(unknown)'} textParts=${textParts.length} totalTextLen=${totalTextLen} streamedTextLen=${accumulatedStreamedTextLen} preview=${JSON.stringify(preview)}`,
      );
      if (assistantText) {
        appendConversation(job, 'assistant', assistantText);
      }
      if (accumulatedStreamedTextLen > totalTextLen && totalTextLen > 0) {
        appendLog(
          logPath,
          `OpenCode SSE warning: assistant.message snapshot (${totalTextLen} chars) is shorter than streamed text (${accumulatedStreamedTextLen} chars) — UI will keep longer streamed text`,
        );
      }
      if (totalTextLen > 0 && totalTextLen <= 20) {
        appendLog(
          logPath,
          `OpenCode SSE warning: assistant.message is very short (${totalTextLen} chars) — common with Gemma 4 thinking mode; verify reasoning_effort=none in opencode.json`,
        );
      }
      if (reasoningDeltaEmittedCount > 0 && textDeltaEmittedCount === 0 && totalTextLen <= 20) {
        appendLog(
          logPath,
          'OpenCode SSE warning: only reasoning deltas were emitted with short final message — likely OpenCode/AI SDK not mapping Gemma thinking output to content',
        );
      }
      accumulatedStreamedTextLen = 0;
      accumulatedStreamedText = '';

      // Extract and accumulate token usage from this message
      const msgTokens = extractMessageTokenUsage(mapped.payload, runConfig.modelTokenCosts ?? {});
      if (msgTokens) {
        totalInputTokens += msgTokens.input;
        totalOutputTokens += msgTokens.output;
        totalCacheReadTokens += msgTokens.cacheRead;
        totalCacheWriteTokens += msgTokens.cacheWrite;
        totalCost += msgTokens.cost;
        costEstimated ||= msgTokens.estimatedCost;
        hasTokenUsage = true;
        logOpenCodeSseEvent(
          `token usage model=${msgTokens.model} input=${msgTokens.input} output=${msgTokens.output} cacheRead=${msgTokens.cacheRead} cost=$${msgTokens.cost.toFixed(6)}${msgTokens.estimatedCost ? ' (estimated from configured rates)' : ''} | session total: input=${totalInputTokens} output=${totalOutputTokens} cost=$${totalCost.toFixed(6)}`,
        );
        const usage: AgentTokenUsage = {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          ...(totalCacheReadTokens > 0 ? { cacheReadTokens: totalCacheReadTokens } : {}),
          ...(totalCacheWriteTokens > 0 ? { cacheWriteTokens: totalCacheWriteTokens } : {}),
          cost: totalCost,
          ...(costEstimated ? { costEstimated: true } : {}),
        };
        updateAgentRecord(agentsStore, job.agentId, { tokenUsage: usage });
      }
    }
    if (mapped.type === 'tool.end') {
      const tool = mapped.payload.tool as NormalizedTool | undefined;
      if (tool) {
        const label = tool.title && tool.title !== tool.name ? `${tool.name}: ${tool.title}` : tool.name;
        appendLog(logPath, `Tool ${label} — ${tool.status}`);
        if (tool.input !== undefined) {
          appendLogBlock(
            logPath,
            'Tool input:',
            typeof tool.input === 'string' ? tool.input : JSON.stringify(tool.input, null, 2),
          );
        }
        if (tool.output) {
          appendLogBlock(logPath, 'Tool output:', tool.output);
        }
        if (tool.error) {
          appendLogBlock(logPath, 'Tool error:', tool.error);
        }
      }
    }
    if (mapped.status) {
      const current = readAgentStatus(agentsStore, job.agentId);
      if (current && sseLockedStatuses.has(current)) {
        if (mapped.status === 'failed') {
          sessionFailed = true;
          failureMessage =
            typeof mapped.payload.error === 'object' && mapped.payload.error !== null
              ? JSON.stringify(mapped.payload.error)
              : 'OpenCode session error';
        }
        return;
      }

      if (mapped.status === 'processing') {
        seenBusySinceProcessing = true;
      }

      const patch: Partial<Agent> = {
        status: mapped.status,
        lastActivityAt: new Date().toISOString(),
      };
      if (mapped.status === 'failed') {
        sessionFailed = true;
        failureMessage =
          typeof mapped.payload.error === 'object' && mapped.payload.error !== null
            ? JSON.stringify(mapped.payload.error)
            : 'OpenCode session error';
      }
      updateAgentRecord(agentsStore, job.agentId, patch);
    }
  };

  try {
    await sessionRunner.startServer();
    appendLog(logPath, `OpenCode serve spawned; waiting for ready on port ${sessionRunner.port}…`);
    await sessionRunner.waitForServerReady();
    appendLog(
      logPath,
      `OpenCode serve ready on ${sessionRunner.baseUrl} (port ${sessionRunner.port})`,
    );

    eventSubscription = sessionRunner.subscribeEvents(handleOpenCodeEvent);
    await eventSubscription.ready;
    appendLog(logPath, 'OpenCode SSE connected');

    const session = await sessionRunner.createSession(`agent-${job.agentId}`, { model: modelRef, agent: 'build' });
    sessionId = session.id;
    appendLog(logPath, `OpenCode session created: ${sessionId}`);

    updateAgentRecord(agentsStore, job.agentId, {
      opencodeSessionId: sessionId,
      turnCount: 0,
      lastActivityAt: new Date().toISOString(),
      status: 'processing',
    });

    // P4-T5: the host bootstrap outcome is summarized for the model so
    // it doesn't spend turns rediscovering the environment, and a
    // failed bootstrap feeds the error tail so the agent can attempt a
    // fix (skipped bootstrap produces no block).
    const bootstrapSummary = formatBootstrapSummaryBlock(
      readAgentRecord(agentsStore, job.agentId)?.bootstrap,
    );
    const initialText = buildOpenCodePrompt(
      bootstrapSummary
        ? `${bootstrapSummary}\n\n${job.prompt}`
        : job.prompt,
      job.systemPrompt,
      repoPromptOverrides ?? undefined,
      config.systemPrompt,
    );
    appendConversation(job, 'user', bootstrapSummary ? `${bootstrapSummary}\n\n${job.prompt}` : job.prompt);
    await sessionRunner.sendPromptAsync(sessionId, {
      parts: [{ type: 'text', text: initialText }],
      agent: 'build',
      ...(modelRef ? { model: modelRef } : {}),
    });
    turnCount = 1;
    updateAgentRecord(agentsStore, job.agentId, { turnCount, status: 'processing' });

    while (!sessionFailed) {
      if (isAgentRunTimedOut(sessionStartedAt, timeoutMs)) {
        throw new Error(`Session timed out after ${Math.round(timeoutMs / 1000)}s`);
      }

      const agentStatus = readAgentStatus(agentsStore, job.agentId);
      if (agentStatus === 'cancelled') {
        appendLog(logPath, 'Agent cancelled — aborting OpenCode session');
        if (sessionId) {
          await sessionRunner.abort(sessionId);
        }
        return { outcome: 'cancelled', sessionId };
      }

      if (sessionId) {
        try {
          const statusMap = await sessionRunner.getSessionStatusMap();
          const status = statusMap[sessionId];
          if (status?.type === 'busy' || status?.type === 'retry') {
            batchPromptBusySeen = true;
          }
          const batchBusySeen = batchPromptBusySeen || seenBusySinceProcessing;
          if (isBatchTurnComplete(statusMap, sessionId, batchBusySeen)) {
            appendLog(logPath, 'OpenCode session idle after task prompt — batch turn complete');
            appendLog(
              logPath,
              `OpenCode text stream final: textDeltaEvents=${textDeltaEventCount} textDeltaEmitted=${textDeltaEmittedCount} textUpdatedEvents=${textUpdatedEventCount} reasoningDeltaEvents=${reasoningDeltaEventCount} reasoningDeltaEmitted=${reasoningDeltaEmittedCount} reasoningUpdatedEvents=${reasoningUpdatedEventCount}`,
            );
            return { outcome: 'turn_complete', sessionId };
          }
        } catch {
          /* transient status poll failure */
        }
      }

      await sleep(300);
    }

    return {
      outcome: 'failed',
      sessionId,
      failureMessage: failureMessage || 'OpenCode session failed',
    };
  } finally {
    if (hasTokenUsage) {
      appendLog(
        logPath,
        `OpenCode token usage total: inputTokens=${totalInputTokens} outputTokens=${totalOutputTokens} cacheRead=${totalCacheReadTokens} cacheWrite=${totalCacheWriteTokens} cost=$${totalCost.toFixed(6)}`,
      );
    }
    eventSubscription?.unsubscribe();
    await sessionRunner.dispose();
  }
}
