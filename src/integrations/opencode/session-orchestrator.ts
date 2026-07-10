import fs from 'fs';
import path from 'path';
import {
  createOpenCodeConfigService,
  excludeWorkspaceInfrastructureFromGit,
  isGemmaThinkingModel,
} from '../../services/opencode-config';
import type { NormalizedTool } from '../../lib/tool-event';
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
  readAgentStatus,
  updateAgentRecord,
} from '../../domains/agents/worker/agent-state-writer';
import { logOpenCodeRunContext, resolveRunConfig } from '../../domains/agents/worker/batch-run-flow';
import { resolveLoopStepModel } from '../../domains/agents/worker/loop-model';
import { captureGitStatusCheckpoint } from '../../domains/agents/worker/workspace-setup';
import { loadRepoConfig } from '../../domains/agents/worker/repo-config';
import type { WorkerContext } from '../../domains/agents/worker/worker-context';
import type { Agent, AgentJob, AgentStatus, AgentTokenUsage, LoopVerb } from '../../types';
import { createOpenCodeEventMapper, type AgentRunMode } from './event-mapper';
import {
  buildModelRef,
  buildOpenCodePrompt,
  parseTimeoutMs,
  type OpenCodeModelRef,
} from './runner';
import {
  createOpenCodeSessionRunner,
  isBatchTurnComplete,
  type OpenCodeServerEvent,
  type OpenCodeSessionRunner,
} from './session-runner';

export type SessionInboxCommand =
  | { type: 'message'; text: string; ts?: string }
  | { type: 'finish'; ts?: string };

export type SessionOrchestratorOutcome = 'finish' | 'cancelled' | 'incomplete' | 'failed' | 'turn_complete';

export interface SessionOrchestratorOptions {
  mode: AgentRunMode;
  ctx: WorkerContext;
  /** PR2: merge permission allow block into per-agent opencode.json */
  autoApprovePermissions?: boolean;
  pollInbox?: () => SessionInboxCommand[];
  pollFinishBeforeStart?: () => boolean;
  onFinishRequested?: () => void;
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
  tokens?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  cost?: number;
  model?: string;
}

/**
 * Extract token counts and cost from an assistant.message payload's `info` field.
 * Returns null if no token data is present.
 */
function extractMessageTokenUsage(payload: Record<string, unknown>): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  model: string;
} | null {
  const msgInfo = payload.info as MessageTokenInfo | undefined;
  const tokens = msgInfo?.tokens;
  if (!tokens) {
    return null;
  }
  return {
    input: typeof tokens.input === 'number' ? tokens.input : 0,
    output: typeof tokens.output === 'number' ? tokens.output : 0,
    cacheRead: typeof tokens.cache_read === 'number' ? tokens.cache_read : 0,
    cacheWrite: typeof tokens.cache_write === 'number' ? tokens.cache_write : 0,
    cost: typeof msgInfo?.cost === 'number' ? msgInfo.cost : 0,
    model: typeof msgInfo?.model === 'string' ? msgInfo.model : '(unknown)',
  };
}

export async function runSessionOrchestrator(
  options: SessionOrchestratorOptions,
): Promise<SessionOrchestratorResult> {
  const { mode, ctx, pollInbox, pollFinishBeforeStart, onFinishRequested } = options;
  const autoApprovePermissions = options.autoApprovePermissions ?? false;

  const { job, logPath, config, agentsStore } = ctx;
  const repoPromptOverrides = loadRepoConfig(job.workspaceDir);
  const agentDir = getAgentDir(job);
  const runConfig = resolveRunConfig(config, job);
  const modelRef = buildModelRef(runConfig);
  const eventWriter = new EventWriter(getEventsPath(job));
  fs.mkdirSync(agentDir, { recursive: true });

  const perAgentConfig = createOpenCodeConfigService({
    configDir: path.join(agentDir, 'opencode-config'),
  });
  perAgentConfig.writeOpenCodeConfig(runConfig, { autoApprovePermissions });
  const opencodeConfigPath = path.join(agentDir, 'opencode-config', 'opencode.json');
  appendLog(logPath, `OpenCode config written: ${opencodeConfigPath}`);
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

  appendLog(
    logPath,
    mode === 'interactive'
      ? 'Starting interactive OpenCode session…'
      : 'Starting OpenCode session…',
  );
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
  let finishRequested = false;
  let sessionFailed = false;
  let failureMessage: string | null = null;
  const sessionStartedAt = Date.now();
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
    if (
      mode === 'batch' &&
      autoApprovePermissions &&
      (ocEvent.type === 'permission.asked' || ocEvent.type === 'permission.updated')
    ) {
      const requestId =
        typeof ocEvent.properties.id === 'string' ? ocEvent.properties.id : undefined;
      if (requestId) {
        void sessionRunner
          .replyPermission(requestId, 'once')
          .then(() => appendLog(logPath, `OpenCode permission auto-approved: ${requestId}`))
          .catch((err) =>
            appendLog(
              logPath,
              `OpenCode permission auto-approve failed (${err instanceof Error ? err.message : String(err)})`,
            ),
          );
      }
    }

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

    const { event: mapped, debug } = eventMapper.map(ocEvent, sessionId, mode);

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
      const deltaText = mapped.payload.text;
      if (typeof deltaText === 'string') {
        accumulatedStreamedTextLen += deltaText.length;
        accumulatedStreamedText += deltaText;
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
      const msgTokens = extractMessageTokenUsage(mapped.payload);
      if (msgTokens) {
        totalInputTokens += msgTokens.input;
        totalOutputTokens += msgTokens.output;
        totalCacheReadTokens += msgTokens.cacheRead;
        totalCacheWriteTokens += msgTokens.cacheWrite;
        totalCost += msgTokens.cost;
        hasTokenUsage = true;
        logOpenCodeSseEvent(
          `token usage model=${msgTokens.model} input=${msgTokens.input} output=${msgTokens.output} cacheRead=${msgTokens.cacheRead} cost=$${msgTokens.cost.toFixed(6)} | session total: input=${totalInputTokens} output=${totalOutputTokens} cost=$${totalCost.toFixed(6)}`,
        );
        const usage: AgentTokenUsage = {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          ...(totalCacheReadTokens > 0 ? { cacheReadTokens: totalCacheReadTokens } : {}),
          ...(totalCacheWriteTokens > 0 ? { cacheWriteTokens: totalCacheWriteTokens } : {}),
          cost: totalCost,
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

      if (
        mapped.status === 'awaiting_input' &&
        current === 'processing' &&
        !seenBusySinceProcessing
      ) {
        return;
      }

      const patch: Partial<Agent> = {
        status: mapped.status,
        lastActivityAt: new Date().toISOString(),
      };
      if (mapped.status === 'awaiting_input') {
        patch.awaitingInputSince = new Date().toISOString();
        seenBusySinceProcessing = false;
      }
      if (mapped.status === 'awaiting_input' && mode === 'interactive') {
        void (async () => {
          try {
            await captureGitStatusCheckpoint({
              gitService: ctx.gitService,
              workspaceDir: job.workspaceDir,
              logPath,
              agentsStore,
              agentId: job.agentId,
            });
          } catch (err) {
            appendLog(
              logPath,
              `Checkpoint git status failed (${err instanceof Error ? err.message : String(err)})`,
            );
          }
          updateAgentRecord(agentsStore, job.agentId, patch);
        })();
        return;
      }
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

  const requestFinish = () => {
    if (finishRequested) {
      return;
    }
    finishRequested = true;
    onFinishRequested?.();
  };

  try {
    if (pollFinishBeforeStart?.()) {
      requestFinish();
    }

    if (!finishRequested && readAgentStatus(agentsStore, job.agentId) === 'completing') {
      requestFinish();
    }

    if (!finishRequested) {
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

      if (pollFinishBeforeStart?.()) {
        requestFinish();
      } else {
        const session = await sessionRunner.createSession(`agent-${job.agentId}`);
        sessionId = session.id;
        appendLog(logPath, `OpenCode session created: ${sessionId}`);

        updateAgentRecord(agentsStore, job.agentId, {
          opencodeSessionId: sessionId,
          turnCount: 0,
          lastActivityAt: new Date().toISOString(),
          status: 'processing',
        });

        if (pollFinishBeforeStart?.()) {
          requestFinish();
        } else {
          if (mode === 'batch') {
            seenBusySinceProcessing = false;
            batchPromptBusySeen = false;
          }

          const initialText = buildOpenCodePrompt(
            job.prompt,
            job.systemPrompt,
            mode === 'interactive' ? 'interactive' : 'batch',
            undefined,
            repoPromptOverrides ?? undefined,
            config.systemPrompt,
          );
          appendConversation(job, 'user', job.prompt);
          await sessionRunner.sendPromptAsync(sessionId, {
            parts: [{ type: 'text', text: initialText }],
            agent: 'build',
            ...(modelRef ? { model: modelRef } : {}),
          });
          turnCount = 1;
          updateAgentRecord(agentsStore, job.agentId, { turnCount, status: 'processing' });
        }
      }
    }

    while (!finishRequested && !sessionFailed) {
      if (Date.now() - sessionStartedAt > timeoutMs) {
        throw new Error(
          mode === 'interactive'
            ? `Interactive session timed out after ${Math.round(timeoutMs / 1000)}s`
            : `Session timed out after ${Math.round(timeoutMs / 1000)}s`,
        );
      }

      const agentStatus = readAgentStatus(agentsStore, job.agentId);
      if (agentStatus === 'cancelled') {
        appendLog(logPath, 'Agent cancelled — aborting OpenCode session');
        if (sessionId) {
          await sessionRunner.abort(sessionId);
        }
        return { outcome: 'cancelled', sessionId };
      }

      if (mode === 'batch' && sessionId) {
        try {
          const res = await fetch(`${sessionRunner.baseUrl}/session/status`);
          if (res.ok) {
            const statusMap = (await res.json()) as Record<string, { type?: string } | undefined>;
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
          }
        } catch {
          /* transient status poll failure */
        }
      }

      const commands = pollInbox?.() ?? [];
      for (const command of commands) {
        if (command.type === 'finish') {
          requestFinish();
          break;
        }

        if (command.type === 'message') {
          appendLog(logPath, `Follow-up message: ${command.text.slice(0, 80)}…`);
          appendConversation(job, 'user', command.text);
          seenBusySinceProcessing = false;
          updateAgentRecord(agentsStore, job.agentId, {
            status: 'processing',
            messagesPreview: command.text.slice(0, 200),
            lastActivityAt: new Date().toISOString(),
          });
          await sessionRunner.sendPromptAsync(sessionId, {
            parts: [{ type: 'text', text: command.text }],
            agent: 'build',
            ...(modelRef ? { model: modelRef } : {}),
          });
          turnCount += 1;
          updateAgentRecord(agentsStore, job.agentId, { turnCount });
        }
      }

      if (sessionFailed) {
        break;
      }

      await sleep(300);
    }

    if (sessionFailed && !finishRequested) {
      return {
        outcome: 'failed',
        sessionId,
        failureMessage: failureMessage || 'OpenCode session failed',
      };
    }

    if (finishRequested) {
      if (sessionId) {
        await sessionRunner.abort(sessionId);
      }
      return { outcome: 'finish', sessionId };
    }

    return { outcome: 'incomplete', sessionId };
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

export type LoopTurnOutcome = 'turn_complete' | 'cancelled' | 'failed' | 'timeout';

export interface LoopTurnResult {
  outcome: LoopTurnOutcome;
  assistantText: string | null;
  failureMessage?: string;
}

export interface OpenCodeLoopSessionHandle {
  sessionRunner: OpenCodeSessionRunner;
  readonly sessionId: string;
  eventWriter: EventWriter;
  modelRef: OpenCodeModelRef | null;
  ctx: WorkerContext;
  timeoutMs: number;
  sessionStartedAt: number;
  turnCount: number;
  dispose: () => Promise<void>;
  runTurn: (options: {
    conversationText: string;
    promptText: string;
    model?: OpenCodeModelRef;
  }) => Promise<LoopTurnResult>;
  /** Create a fresh OpenCode session in the running process, discarding accumulated conversation history. */
  rotateSession: () => Promise<void>;
}

function resolveTurnAssistantText(state: {
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

function appendTurnAssistantConversation(
  job: AgentJob,
  assistantText: string | null | undefined,
): void {
  const text = assistantText?.trim();
  if (text) {
    appendConversation(job, 'assistant', text);
  }
}

export async function startOpenCodeLoopSession(options: {
  ctx: WorkerContext;
  autoApprovePermissions: boolean;
}): Promise<OpenCodeLoopSessionHandle> {
  const { ctx, autoApprovePermissions } = options;
  const { job, logPath, config, agentsStore } = ctx;
  const agentDir = getAgentDir(job);
  const runConfig = resolveRunConfig(config, job);
  const modelRef = buildModelRef(runConfig);
  const eventWriter = new EventWriter(getEventsPath(job));
  fs.mkdirSync(agentDir, { recursive: true });

  const perAgentConfig = createOpenCodeConfigService({
    configDir: path.join(agentDir, 'opencode-config'),
  });
  perAgentConfig.writeOpenCodeConfig(runConfig, { autoApprovePermissions, job });
  excludeWorkspaceInfrastructureFromGit(job.workspaceDir);

  const loopVerbs: LoopVerb[] = ['INITIAL_PLAN', 'OBSERVE', 'PLAN', 'ACT', 'REFLECT'];
  appendLog(
    logPath,
    `Loop verb models: ${loopVerbs
      .map((verb) => `${verb}=${resolveLoopStepModel(verb, runConfig, job) ?? 'default'}`)
      .join(', ')}`,
  );

  appendLog(logPath, 'Starting OpenCode loop session…');
  logOpenCodeRunContext(logPath, {
    config: runConfig,
    job,
    timeoutMs: parseTimeoutMs(job.agentTimeoutMs),
  });

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
  const sessionStartedAt = Date.now();
  const timeoutMs = parseTimeoutMs(job.agentTimeoutMs);
  let eventSubscription: { unsubscribe: () => void; ready: Promise<void> } | undefined;
  const eventMapper = createOpenCodeEventMapper();
  const loopMode: AgentRunMode = 'batch';

  // Cumulative token usage across all loop turns
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  let totalCost = 0;
  let hasTokenUsage = false;

  const sseLockedStatuses = new Set<AgentStatus>([
    'queued',
    'completing',
    'completed',
    'failed',
    'cancelled',
  ]);

  const turnState = {
    seenBusySinceProcessing: false,
    batchPromptBusySeen: false,
    lastAssistantText: null as string | null,
    streamedAssistantText: '',
  };

  const handleOpenCodeEvent = (ocEvent: OpenCodeServerEvent) => {
    if (
      autoApprovePermissions &&
      (ocEvent.type === 'permission.asked' || ocEvent.type === 'permission.updated')
    ) {
      const requestId =
        typeof ocEvent.properties.id === 'string' ? ocEvent.properties.id : undefined;
      if (requestId) {
        void sessionRunner
          .replyPermission(requestId, 'once')
          .then(() => appendLog(logPath, `OpenCode permission auto-approved: ${requestId}`))
          .catch((err) =>
            appendLog(
              logPath,
              `OpenCode permission auto-approve failed (${err instanceof Error ? err.message : String(err)})`,
            ),
          );
      }
    }

    const { event: mapped } = eventMapper.map(ocEvent, sessionId, loopMode);
    if (!mapped) {
      return;
    }

    eventWriter.write(mapped.type, mapped.payload, sessionId || undefined);

    if (mapped.type === 'assistant.delta') {
      const deltaText = mapped.payload.text;
      if (typeof deltaText === 'string') {
        turnState.streamedAssistantText += deltaText;
      }
    }

    if (mapped.type === 'assistant.message') {
      const text = extractAssistantTextFromPayload(mapped.payload);
      if (text) {
        turnState.lastAssistantText = text;
      }

      const msgTokens = extractMessageTokenUsage(mapped.payload);
      if (msgTokens) {
        totalInputTokens += msgTokens.input;
        totalOutputTokens += msgTokens.output;
        totalCacheReadTokens += msgTokens.cacheRead;
        totalCacheWriteTokens += msgTokens.cacheWrite;
        totalCost += msgTokens.cost;
        hasTokenUsage = true;
        appendLog(
          logPath,
          `OpenCode SSE: token usage model=${msgTokens.model} input=${msgTokens.input} output=${msgTokens.output} cacheRead=${msgTokens.cacheRead} cost=$${msgTokens.cost.toFixed(6)} | session total: input=${totalInputTokens} output=${totalOutputTokens} cost=$${totalCost.toFixed(6)}`,
        );
        const usage: AgentTokenUsage = {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          ...(totalCacheReadTokens > 0 ? { cacheReadTokens: totalCacheReadTokens } : {}),
          ...(totalCacheWriteTokens > 0 ? { cacheWriteTokens: totalCacheWriteTokens } : {}),
          cost: totalCost,
        };
        updateAgentRecord(agentsStore, job.agentId, { tokenUsage: usage });
      }
    }

    if (mapped.type === 'tool.end') {
      const tool = mapped.payload.tool as NormalizedTool | undefined;
      if (tool) {
        const label = tool.title && tool.title !== tool.name ? `${tool.name}: ${tool.title}` : tool.name;
        appendLog(logPath, `Tool ${label} — ${tool.status}`);
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
        turnState.seenBusySinceProcessing = true;
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

  await sessionRunner.startServer();
  appendLog(logPath, `OpenCode serve spawned; waiting for ready on port ${sessionRunner.port}…`);
  await sessionRunner.waitForServerReady();
  appendLog(logPath, `OpenCode serve ready on ${sessionRunner.baseUrl} (port ${sessionRunner.port})`);

  eventSubscription = sessionRunner.subscribeEvents(handleOpenCodeEvent);
  await eventSubscription.ready;
  appendLog(logPath, 'OpenCode SSE connected');

  const session = await sessionRunner.createSession(`agent-${job.agentId}`);
  sessionId = session.id;
  appendLog(logPath, `OpenCode session created: ${sessionId}`);

  updateAgentRecord(agentsStore, job.agentId, {
    opencodeSessionId: sessionId,
    turnCount: 0,
    lastActivityAt: new Date().toISOString(),
    status: 'processing',
  });

  async function runTurn(options: {
    conversationText: string;
    promptText: string;
    model?: OpenCodeModelRef;
  }): Promise<LoopTurnResult> {
    turnState.seenBusySinceProcessing = false;
    turnState.batchPromptBusySeen = false;
    turnState.lastAssistantText = null;
    turnState.streamedAssistantText = '';
    eventMapper.reset();

    if (Date.now() - sessionStartedAt > timeoutMs) {
      return { outcome: 'timeout', assistantText: null };
    }

    const agentStatus = readAgentStatus(agentsStore, job.agentId);
    if (agentStatus === 'cancelled') {
      appendLog(logPath, 'Agent cancelled — aborting loop turn');
      if (sessionId) {
        await sessionRunner.abort(sessionId);
      }
      return { outcome: 'cancelled', assistantText: null };
    }

    const turnModelRef = options.model ?? modelRef;

    appendConversation(job, 'user', options.conversationText);
    await sessionRunner.sendPromptAsync(sessionId, {
      parts: [{ type: 'text', text: options.promptText }],
      agent: 'build',
      ...(turnModelRef ? { model: turnModelRef } : {}),
    });
    turnCount += 1;
    updateAgentRecord(agentsStore, job.agentId, { turnCount, status: 'processing' });

    function finishTurn(result: LoopTurnResult): LoopTurnResult {
      appendTurnAssistantConversation(job, result.assistantText);
      return result;
    }

    while (!sessionFailed) {
      if (Date.now() - sessionStartedAt > timeoutMs) {
        return finishTurn({ outcome: 'timeout', assistantText: resolveTurnAssistantText(turnState) });
      }

      const currentStatus = readAgentStatus(agentsStore, job.agentId);
      if (currentStatus === 'cancelled') {
        appendLog(logPath, 'Agent cancelled during loop turn');
        if (sessionId) {
          await sessionRunner.abort(sessionId);
        }
        return finishTurn({
          outcome: 'cancelled',
          assistantText: resolveTurnAssistantText(turnState),
        });
      }

      try {
        const res = await fetch(`${sessionRunner.baseUrl}/session/status`);
        if (res.ok) {
          const statusMap = (await res.json()) as Record<string, { type?: string } | undefined>;
          const status = statusMap[sessionId];
          if (status?.type === 'busy' || status?.type === 'retry') {
            turnState.batchPromptBusySeen = true;
          }
          const batchBusySeen = turnState.batchPromptBusySeen || turnState.seenBusySinceProcessing;
          if (isBatchTurnComplete(statusMap, sessionId, batchBusySeen)) {
            appendLog(logPath, 'OpenCode session idle — loop step complete');
            return finishTurn({
              outcome: 'turn_complete',
              assistantText: resolveTurnAssistantText(turnState),
            });
          }
        }
      } catch {
        /* transient status poll failure */
      }

      await sleep(300);
    }

    return finishTurn({
      outcome: 'failed',
      assistantText: resolveTurnAssistantText(turnState),
      failureMessage: failureMessage || 'OpenCode session failed',
    });
  }

  async function dispose(): Promise<void> {
    if (hasTokenUsage) {
      appendLog(
        logPath,
        `OpenCode token usage total: inputTokens=${totalInputTokens} outputTokens=${totalOutputTokens} cacheRead=${totalCacheReadTokens} cacheWrite=${totalCacheWriteTokens} cost=$${totalCost.toFixed(6)}`,
      );
    }
    eventSubscription?.unsubscribe();
    await sessionRunner.dispose();
  }

  async function rotateSession(): Promise<void> {
    const newSess = await sessionRunner.createSession(`agent-${job.agentId}`);
    sessionId = newSess.id;
    turnState.seenBusySinceProcessing = false;
    turnState.batchPromptBusySeen = false;
    turnState.lastAssistantText = null;
    turnState.streamedAssistantText = '';
    eventMapper.reset();
    appendLog(logPath, `OpenCode session rotated: new sessionId=${sessionId}`);
    updateAgentRecord(agentsStore, job.agentId, {
      opencodeSessionId: sessionId,
      lastActivityAt: new Date().toISOString(),
    });
  }

  return {
    sessionRunner,
    get sessionId() { return sessionId; },
    eventWriter,
    modelRef,
    ctx,
    timeoutMs,
    sessionStartedAt,
    turnCount,
    dispose,
    runTurn,
    rotateSession,
  };
}
