import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { buildInteractiveState } from '../../lib/interactive-state';
import { buildLoopState } from '../../lib/loop-state';
import { createWebhookSender } from '../../lib/webhook';
import {
  buildDefaultPullRequestBody,
  buildDefaultPullRequestTitle,
  canCreatePullRequest,
  mapGitHubPullRequest,
} from '../../lib/agent-pull-request';
import {
  enrichGeneratedPullRequestBody,
  extractAssistantSummary,
  generatePullRequestContent,
  MAX_DIFF_PATCH_CHARS,
  MAX_LOG_CHARS,
  resolvePullRequestMessages,
  truncateText,
} from '../../lib/pr-content-generator';
import { getLogger } from '../../lib/logger';
import { parsePositiveInt } from '../../lib/parse';
import { CodedError, getErrorMessage } from '../../types';
import type { Agent, AgentJob, SpawnFn } from '../../types';
import type { JsonStore } from '../../lib/json-store';
import type { ConfigRepository } from '../config/config.repository';
import type { RepoService } from '../repos/repo.service';
import type { GithubAppService } from '../../services/github-app';
import type { GitService } from '../../services/git-service';
import type { OllamaChatService } from '../../services/ollama-client';
import type { WebhookSender } from '../../lib/webhook';
import { createAgentRepository, type AgentRepository } from './agent.repository';
import { createAgentQueue } from './agent-queue';
import { createWorkerSpawner } from './worker-spawner';
import { parseCreateAgentPayload, parseMessageText } from './agent.validation';
import { appendLog } from './worker/agent-state-writer';
import { finalizeGitChanges } from './worker/workspace-setup';
import {
  ACTIVE_STATUSES,
  BATCH_ACTIVE_STATUSES,
  getAgentMode,
  INTERACTIVE_ACTIVE_STATUSES,
  LOOP_ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  withInteractiveFields,
  withLoopFields,
} from './agent.types';
import type { CreateAgentRequest } from './dto';

export {
  TERMINAL_STATUSES,
  BATCH_ACTIVE_STATUSES,
  ACTIVE_STATUSES,
  INTERACTIVE_ACTIVE_STATUSES,
  LOOP_ACTIVE_STATUSES,
} from './agent.types';

export interface AgentService {
  createAgent: (body: CreateAgentRequest) => Agent;
  getAgent: (agentId: string) => Agent;
  listAgents: (filters?: { repoId?: string; status?: string }) => Agent[];
  readLogs: (agentId: string, tailLines?: number) => { logs: string; tail: number };
  readEvents: (agentId: string, sinceSeq?: number) => import('../../types').AgentEvent[];
  getLastEventSeq: (agentId: string) => number;
  readMessages: (agentId: string) => import('../../types').AgentMessage[];
  sendMessage: (agentId: string, text: unknown) => Agent;
  finishAgent: (agentId: string) => Agent;
  commitOutstandingChanges: (agentId: string) => Promise<Agent>;
  cancelAgent: (agentId: string) => Agent;
  deleteAgent: (agentId: string) => void;
  cleanupOldWorkspaces: (daysToKeep: number) => CleanupOldWorkspacesResult;
  createPullRequest: (
    agentId: string,
    options?: { title?: string; body?: string },
  ) => Promise<Agent>;
  refreshPullRequest: (agentId: string) => Promise<Agent>;
  restoreOnStartup: () => void;
  shutdown: () => Promise<void>;
  maxConcurrent: number;
  agentTimeoutMs: number;
}

export interface CleanupOldWorkspacesResult {
  daysToKeep: number;
  deleted: string[];
  skippedActive: string[];
  orphanWorkspacesRemoved: string[];
}

type FsLike = Pick<
  typeof fs,
  | 'mkdirSync'
  | 'existsSync'
  | 'writeFileSync'
  | 'readFileSync'
  | 'appendFileSync'
  | 'rmSync'
  | 'readdirSync'
  | 'statSync'
>;

export function createAgentService(options: {
  fs?: FsLike;
  path?: typeof path;
  spawn?: SpawnFn;
  dataDir: string;
  agentsStore: JsonStore<{ agents: Agent[] }>;
  repoManager: RepoService;
  configRepository: ConfigRepository;
  githubApp: GithubAppService;
  gitService?: GitService;
  ollamaChat?: OllamaChatService;
  webhookSender?: WebhookSender;
  workspaceRoot: string;
  maxConcurrent?: unknown;
  agentTimeoutMs?: unknown;
  interactiveAgentTimeoutFallbackSeconds?: unknown;
  loopAgentTimeoutFallbackSeconds?: unknown;
  repository?: AgentRepository;
}): AgentService {
  const fsImpl = options.fs || fs;
  const pathImpl = options.path || path;
  const dataDir = options.dataDir;
  const repoManager = options.repoManager;
  const configRepository = options.configRepository;
  const githubApp = options.githubApp;
  const gitService = options.gitService;
  const ollamaChat = options.ollamaChat;
  const { sendWebhook: postWebhook } = options.webhookSender || createWebhookSender();
  const workspaceRoot = options.workspaceRoot;
  const maxConcurrent = parsePositiveInt(options.maxConcurrent, 3);
  const agentTimeoutMs = parsePositiveInt(options.agentTimeoutMs, 3600000);
  const interactiveAgentTimeoutFallbackSeconds = parsePositiveInt(
    options.interactiveAgentTimeoutFallbackSeconds,
    3600,
  );
  const loopAgentTimeoutFallbackSeconds = parsePositiveInt(
    options.loopAgentTimeoutFallbackSeconds,
    3600,
  );

  function getInteractiveAgentTimeoutMs(): number {
    const config = configRepository.load();
    const seconds = parsePositiveInt(
      config.interactiveAgentTimeoutSeconds || interactiveAgentTimeoutFallbackSeconds,
      interactiveAgentTimeoutFallbackSeconds,
    );
    return seconds * 1000;
  }

  function getLoopAgentTimeoutMs(): number {
    const config = configRepository.load();
    const seconds = parsePositiveInt(
      config.loopAgentTimeoutSeconds || loopAgentTimeoutFallbackSeconds,
      loopAgentTimeoutFallbackSeconds,
    );
    return seconds * 1000;
  }

  const repository =
    options.repository ||
    createAgentRepository({
      dataDir,
      workspaceRoot,
      agentsStore: options.agentsStore,
      fs: fsImpl,
      path: pathImpl,
    });

  function branchInUse(repoId: string, agentBranch: string, excludeAgentId?: string): boolean {
    return repository.findAll().some(
      (agent) =>
        agent.repoId === repoId &&
        agent.agentBranch === agentBranch &&
        ACTIVE_STATUSES.has(agent.status) &&
        agent.agentId !== excludeAgentId,
    );
  }

  function sendAgentWebhook(agentId: string, event: string): void {
    const webhookUrl = configRepository.load().webhookUrl?.trim();
    if (!webhookUrl) {
      return;
    }

    const agent = repository.findById(agentId);
    if (!agent || !TERMINAL_STATUSES.has(agent.status)) {
      return;
    }

    postWebhook(webhookUrl, {
      event,
      agent,
      timestamp: new Date().toISOString(),
    }).catch((err) => {
      getLogger().warn({ err, agentId, event: 'webhook.failed' }, 'Webhook delivery failed');
    });
  }

  function handleWorkerExit(agentId: string, code: number | null, signal: NodeJS.Signals | null): void {
    let current = repository.findById(agentId);
    if (!current) {
      return;
    }

    const finishedAt = new Date().toISOString();

    if (current.status === 'cancelled') {
      sendAgentWebhook(agentId, 'agent.cancelled');
      queue.process();
      return;
    }

    const mode = getAgentMode(current);
    const isInteractive = mode === 'interactive';
    const isLoop = mode === 'loop';

    if (isInteractive && INTERACTIVE_ACTIVE_STATUSES.has(current.status) && code === 0) {
      repository.update(agentId, {
        status: 'failed',
        finishedAt,
        error: current.error || 'Interactive worker exited unexpectedly',
      });
      sendAgentWebhook(agentId, 'agent.failed');
      queue.process();
      return;
    }

    if (isInteractive && INTERACTIVE_ACTIVE_STATUSES.has(current.status) && code !== 0) {
      repository.update(agentId, {
        status: 'failed',
        finishedAt,
        error: current.error || `Worker exited with code ${code}`,
      });
      sendAgentWebhook(agentId, 'agent.failed');
      queue.process();
      return;
    }

    if (isLoop && LOOP_ACTIVE_STATUSES.has(current.status) && code === 0) {
      repository.update(agentId, {
        status: 'failed',
        finishedAt,
        error: current.error || 'Loop worker exited unexpectedly',
      });
      sendAgentWebhook(agentId, 'agent.failed');
      queue.process();
      return;
    }

    if (isLoop && LOOP_ACTIVE_STATUSES.has(current.status) && code !== 0) {
      repository.update(agentId, {
        status: 'failed',
        finishedAt,
        error: current.error || `Worker exited with code ${code}`,
      });
      sendAgentWebhook(agentId, 'agent.failed');
      queue.process();
      return;
    }

    if (signal === 'SIGTERM' || signal === 'SIGKILL') {
      if (
        current.status === 'running' ||
        current.status === 'processing' ||
        current.status === 'awaiting_input'
      ) {
        repository.update(agentId, {
          status: 'cancelled',
          finishedAt,
          error: 'Agent cancelled',
        });
        current = repository.findById(agentId);
      }
      if (current?.status === 'cancelled') {
        sendAgentWebhook(agentId, 'agent.cancelled');
      }
      queue.process();
      return;
    }

    if (code !== 0 && ACTIVE_STATUSES.has(current.status)) {
      repository.update(agentId, {
        status: 'failed',
        finishedAt,
        error: current.error || `Worker exited with code ${code}`,
      });
    }

    current = repository.findById(agentId);
    if (current?.status === 'completed') {
      sendAgentWebhook(agentId, 'agent.completed');
      void handleAutoCreatePullRequest(agentId);
    } else if (current?.status === 'failed') {
      sendAgentWebhook(agentId, 'agent.failed');
    }

    queue.process();
  }

  const spawner = createWorkerSpawner({
    repository,
    dataDir,
    workspaceRoot,
    agentTimeoutMs,
    getInteractiveAgentTimeoutMs,
    getLoopAgentTimeoutMs,
    fs: fsImpl,
    path: pathImpl,
    spawn: (options.spawn || spawn) as SpawnFn,
    onWorkerExit: handleWorkerExit,
    onWorkerError: (agentId, message) => {
      repository.update(agentId, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        error: message,
      });
      sendAgentWebhook(agentId, 'agent.failed');
      queue.process();
    },
  });

  const queue = createAgentQueue({
    maxConcurrent,
    getActiveWorkerCount: () => spawner.activeCount(),
    shouldStart: (agentId) => {
      const agent = repository.findById(agentId);
      if (!agent) {
        return false;
      }
      return (
        agent.status === 'queued' ||
        (agent.status === 'completing' && !spawner.has(agentId))
      );
    },
    onStartAgent: (agentId) => {
      const agent = repository.findById(agentId);
      if (agent) {
        spawner.start(agent);
      }
    },
  });

  function createAgent(body: CreateAgentRequest): Agent {
    const repo = repoManager.getRepo(body.repoId);
    const agentId = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const payload = parseCreateAgentPayload(
      body as Record<string, unknown>,
      repo,
      agentId,
    );

    const config = configRepository.load();
    githubApp.assertConfigured(config);

    if (branchInUse(payload.repoId, payload.agentBranch)) {
      throw new CodedError(
        `Agent branch "${payload.agentBranch}" is already in use by an active job on this repo`,
        'BRANCH_IN_USE',
      );
    }
    const workspaceId = crypto.randomUUID();
    const workspaceDir = repository.getWorkspaceDir(workspaceId);

    fsImpl.mkdirSync(workspaceRoot, { recursive: true });
    fsImpl.mkdirSync(workspaceDir, { recursive: true });
    fsImpl.mkdirSync(repository.getAgentDir(agentId), { recursive: true });
    fsImpl.writeFileSync(repository.getLogPath(agentId), '', 'utf8');

    const agent: Agent = {
      agentId,
      workspaceId,
      repoId: payload.repoId,
      mode: payload.mode,
      prompt: payload.prompt,
      systemPrompt: payload.systemPrompt || null,
      baseBranch: payload.baseBranch,
      agentBranch: payload.agentBranch,
      useExistingBranch: payload.useExistingBranch,
      commitMessage: payload.commitMessage,
      push: payload.push,
      pushOnFailure: payload.pushOnFailure,
      autoApprovePermissions: payload.autoApprovePermissions,
      model: payload.model,
      ...(payload.loopVerbModels ? { loopVerbModels: payload.loopVerbModels } : {}),
      status: 'queued',
      commitSha: null,
      pushed: false,
      filesChanged: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      branch: null,
      error: null,
      result: null,
      pullRequest: null,
      autoCreatePullRequest: payload.autoCreatePullRequest,
      ...(payload.mode === 'interactive'
        ? {
            opencodeSessionId: null,
            turnCount: 0,
            lastActivityAt: null,
            awaitingInputSince: null,
            interactive: buildInteractiveState('queued'),
          }
        : {}),
      ...(payload.mode === 'loop'
        ? {
            loop: buildLoopState('queued'),
          }
        : {}),
    };

    repository.save(agent);
    queue.enqueue(agentId);

    return withLoopFields(withInteractiveFields(agent));
  }

  function sendMessage(agentId: string, text: unknown): Agent {
    const agent = repository.getAgent(agentId);
    repository.assertInteractive(agent);

    if (TERMINAL_STATUSES.has(agent.status)) {
      throw new CodedError(`Agent is already ${agent.status}`, 'NOT_ACTIVE');
    }

    if (agent.status !== 'awaiting_input') {
      throw new CodedError('Agent is not ready for messages', 'NOT_READY');
    }

    const sanitized = parseMessageText(text);
    repository.appendInbox(agentId, { type: 'message', text: sanitized, ts: new Date().toISOString() });

    const updated = repository.update(agentId, {
      status: 'processing',
      messagesPreview: sanitized.slice(0, 200),
      lastActivityAt: new Date().toISOString(),
    });
    return withInteractiveFields(updated!);
  }

  function finishAgent(agentId: string): Agent {
    const agent = repository.getAgent(agentId);
    repository.assertFinishable(agent);

    if (TERMINAL_STATUSES.has(agent.status)) {
      throw new CodedError(`Agent is already ${agent.status}`, 'NOT_ACTIVE');
    }

    if (agent.status === 'completing') {
      throw new CodedError('Agent is already finishing', 'NOT_READY');
    }

    repository.appendInbox(agentId, { type: 'finish', ts: new Date().toISOString() });

    const mode = getAgentMode(agent);
    if (mode === 'loop') {
      const loop = buildLoopState(agent.status, {
        ...agent.loop,
        finishRequested: true,
      }, agent);
      const updated = repository.update(agentId, {
        loop,
        lastActivityAt: new Date().toISOString(),
      });
      return withLoopFields(updated!);
    }

    const updated = repository.update(agentId, {
      status: 'completing',
      lastActivityAt: new Date().toISOString(),
    });
    return withInteractiveFields(updated!);
  }

  async function commitOutstandingChanges(agentId: string): Promise<Agent> {
    if (!gitService) {
      throw new CodedError('Git service is not configured', 'NOT_READY');
    }

    const agent = repository.getAgent(agentId);
    if (getAgentMode(agent) !== 'loop') {
      throw new CodedError('Agent is not in loop mode', 'NOT_LOOP');
    }

    if (agent.status !== 'failed') {
      throw new CodedError('Outstanding changes can only be committed for failed loop sessions', 'NOT_READY');
    }

    if (agent.commitSha) {
      throw new CodedError('Changes have already been committed for this session', 'ALREADY_COMMITTED');
    }

    if (!agent.loop?.canCommitOutstanding) {
      throw new CodedError('No outstanding changes to commit', 'NO_CHANGES');
    }

    const workspaceDir = repository.getWorkspaceDir(agent.workspaceId);
    if (!fsImpl.existsSync(workspaceDir)) {
      throw new CodedError('Workspace is no longer available', 'WORKSPACE_MISSING');
    }

    const config = configRepository.load();
    githubApp.assertConfigured(config);
    gitService.applyGitConfig(config);

    const repo = repoManager.getRepo(agent.repoId);
    const logPath = repository.getLogPath(agentId);
    appendLog(logPath, 'Committing outstanding loop changes after failed session…');

    const job: AgentJob = {
      agentId: agent.agentId,
      workspaceId: agent.workspaceId,
      repoId: agent.repoId,
      mode: 'loop',
      prompt: agent.prompt,
      systemPrompt: agent.systemPrompt || undefined,
      baseBranch: agent.baseBranch,
      agentBranch: agent.agentBranch,
      useExistingBranch: agent.useExistingBranch,
      commitMessage: agent.commitMessage,
      push: agent.push,
      pushOnFailure: agent.pushOnFailure,
      autoApprovePermissions: agent.autoApprovePermissions,
      model: agent.model || undefined,
      ...(agent.loopVerbModels ? { loopVerbModels: agent.loopVerbModels } : {}),
      agentTimeoutMs: getLoopAgentTimeoutMs(),
      dataDir,
      workspaceRoot,
      workspaceDir,
      logPath,
    };

    const gitResult = await finalizeGitChanges({
      gitService,
      githubApp,
      config,
      repo,
      job,
      logPath,
      allowCommit: true,
    });

    if (gitResult.filesChanged === 0) {
      throw new CodedError('No file changes to commit', 'NO_CHANGES');
    }

    const finishedAt = new Date().toISOString();
    const warning = agent.error
      ? `Loop failed (${agent.error}); changes committed manually`
      : 'Loop ended without completion signal; changes committed manually';

    const updated = repository.update(agentId, {
      status: 'completed',
      finishedAt,
      branch: agent.agentBranch,
      commitSha: gitResult.commitSha,
      pushed: gitResult.pushed,
      filesChanged: gitResult.filesChanged,
      error: null,
      gitStatus: null,
      result: {
        branch: agent.agentBranch,
        baseBranch: agent.baseBranch,
        workspaceId: agent.workspaceId,
        commitSha: gitResult.commitSha,
        pushed: gitResult.pushed,
        filesChanged: gitResult.filesChanged,
        warning,
        opencodeSuccess: true,
      },
      loop: buildLoopState('completed', agent.loop, {
        ...agent,
        status: 'completed',
        commitSha: gitResult.commitSha,
        gitStatus: null,
      }),
    });

    if (!updated) {
      throw new CodedError('Agent not found', 'NOT_FOUND');
    }

    appendLog(
      logPath,
      `Outstanding changes committed — ${gitResult.filesChanged} file(s) changed, pushed=${gitResult.pushed}`,
    );

    sendAgentWebhook(agentId, 'agent.completed');

    return withLoopFields(updated);
  }

  function cancelAgent(agentId: string): Agent {
    const agent = repository.getAgent(agentId);

    if (TERMINAL_STATUSES.has(agent.status)) {
      throw new CodedError(`Agent is already ${agent.status}`, 'NOT_ACTIVE');
    }

    const child = spawner.kill(agentId);
    queue.remove(agentId);

    repository.update(agentId, {
      status: 'cancelled',
      finishedAt: new Date().toISOString(),
      error: 'Cancelled by user',
    });

    if (!child) {
      sendAgentWebhook(agentId, 'agent.cancelled');
    }

    queue.process();
    return repository.findById(agentId)!;
  }

  async function handleAutoCreatePullRequest(agentId: string, options?: { autoCreatePr?: boolean }): Promise<void> {
    const agent = repository.getAgent(agentId);
    // Default to true for backwards compatibility; false skips PR creation
    if (options?.autoCreatePr ?? agent.autoCreatePullRequest ?? configRepository.load().autoCreatePullRequest) {
      // Check if we can actually create a PR (branch pushed, no existing PR)
      if (canCreatePullRequest(agent)) {
        try {
          await createPullRequest(agentId);
          getLogger().info({ agentId }, 'Auto-created PR on completion');
        } catch (err) {
          const message = getErrorMessage(err);
          // Don't fail the agent if PR creation fails
          if (!/already exists|pull request already/i.test(message)) {
            getLogger().warn({ err, agentId }, 'Auto-PR creation failed');
          }
          // If PR already exists, that's fine - don't error
        }
      }
    }
  }

  function deleteAgent(agentId: string): void {
    const agent = repository.getAgent(agentId);

    if (ACTIVE_STATUSES.has(agent.status)) {
      spawner.kill(agentId);
      queue.remove(agentId);
    }

    repository.remove(agentId);
    repository.removeArtifacts(agent);
    queue.process();
  }

  function cleanupOldWorkspaces(daysToKeep: number): CleanupOldWorkspacesResult {
    if (!Number.isFinite(daysToKeep) || daysToKeep < 1) {
      throw new CodedError('daysToKeep must be at least 1', 'VALIDATION_ERROR');
    }

    const cutoffMs = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
    const deleted: string[] = [];
    const skippedActive: string[] = [];

    for (const agent of repository.findAll()) {
      if (ACTIVE_STATUSES.has(agent.status)) {
        skippedActive.push(agent.agentId);
        continue;
      }

      if (!TERMINAL_STATUSES.has(agent.status)) {
        continue;
      }

      const ageTimestamp = agent.finishedAt || agent.createdAt;
      if (new Date(ageTimestamp).getTime() >= cutoffMs) {
        continue;
      }

      deleteAgent(agent.agentId);
      deleted.push(agent.agentId);
      getLogger().info(
        { agentId: agent.agentId, workspaceId: agent.workspaceId, daysToKeep },
        'Cleaned up old workspace',
      );
    }

    const orphanWorkspacesRemoved: string[] = [];
    const knownWorkspaceIds = new Set(repository.findAll().map((agent) => agent.workspaceId));

    if (fsImpl.existsSync(workspaceRoot)) {
      for (const entry of fsImpl.readdirSync(workspaceRoot)) {
        if (knownWorkspaceIds.has(entry)) {
          continue;
        }

        const fullPath = pathImpl.join(workspaceRoot, entry);
        let isDirectory = false;
        try {
          isDirectory = fsImpl.statSync(fullPath).isDirectory();
        } catch {
          continue;
        }

        if (!isDirectory) {
          continue;
        }

        fsImpl.rmSync(fullPath, { recursive: true, force: true });
        orphanWorkspacesRemoved.push(entry);
        getLogger().info({ workspaceId: entry, daysToKeep }, 'Removed orphan workspace');
      }
    }

    return { daysToKeep, deleted, skippedActive, orphanWorkspacesRemoved };
  }

  async function resolvePullRequestContent(
    agent: Agent,
    base: string,
    repoOwner: string,
    repoName: string,
    overrides: { title?: string; body?: string },
  ): Promise<{ title: string; body: string }> {
    const log = getLogger();
    let title = overrides.title?.trim() || '';
    let body = overrides.body?.trim() || '';
    let source: 'override' | 'llm' | 'assistant-summary' | 'default' = 'default';

    if (title && body) {
      source = 'override';
      log.debug({ agentId: agent.agentId, source }, 'Using explicit PR title and body overrides');
      return { title, body };
    }

    if (!ollamaChat) {
      log.warn(
        { agentId: agent.agentId },
        'PR content service unavailable (ollamaChat not injected); using defaults',
      );
    } else {
      const config = configRepository.load();
      const messages = resolvePullRequestMessages(
        repository.readMessages(agent.agentId),
        repository.readEvents(agent.agentId),
      );
      const assistantSummary = extractAssistantSummary(messages);
      const { logs } = repository.readLogs(agent.agentId, 120);
      const workspaceDir = repository.getWorkspaceDir(agent.workspaceId);

      let diffStat: string | null = null;
      let diffPatch: string | null = null;
      if (gitService && agent.commitSha && fsImpl.existsSync(workspaceDir)) {
        const diff = await gitService.getCommitDiff(workspaceDir, agent.commitSha, {
          maxPatchChars: MAX_DIFF_PATCH_CHARS,
        });
        if (diff) {
          diffStat = diff.stat;
          diffPatch = diff.patch;
        }
      }

      log.debug(
        {
          agentId: agent.agentId,
          hasAssistantSummary: !!assistantSummary,
          messageCount: messages.length,
          hasDiff: !!diffPatch,
          hasCommitMessage: !!agent.commitMessage?.trim(),
          model: agent.model,
          modelsUsed: agent.modelsUsed,
          ollamaConfigured: !!config.ollamaBaseUrl?.trim(),
        },
        'Resolving PR title and body',
      );

      const generated = await generatePullRequestContent(ollamaChat, config, {
        agent,
        base,
        repoOwner,
        repoName,
        messages,
        diffStat,
        diffPatch,
        logExcerpt: logs.trim() ? truncateText(logs.trim(), MAX_LOG_CHARS) : null,
      });

      if (generated) {
        if (!title) {
          title = generated.title;
        }
        if (!body) {
          body = generated.body;
        }
        source = 'llm';
        log.info({ agentId: agent.agentId, source }, 'Generated PR title and body with local LLM');
      } else if (!title || !body) {
        if (assistantSummary) {
          if (!title) {
            const summaryTitle = assistantSummary
              .split('\n')
              .map((line) => line.trim())
              .find((line) => line.length > 0);
            if (summaryTitle) {
              title = summaryTitle.slice(0, 256);
            }
          }
          if (!body) {
            body = enrichGeneratedPullRequestBody(assistantSummary, agent, base);
          }
          if (title && body) {
            source = 'assistant-summary';
            log.info(
              { agentId: agent.agentId, source },
              'Using assistant summary for PR title/body after LLM generation failed',
            );
          }
        }

        if (source !== 'assistant-summary') {
          log.warn(
            {
              agentId: agent.agentId,
              ollamaConfigured: !!config.ollamaBaseUrl?.trim(),
              hasAssistantSummary: !!assistantSummary,
            },
            'PR LLM generation unavailable or failed; falling back to commit message / prompt defaults',
          );
        }
      }
    }

    const resolvedTitle = title || buildDefaultPullRequestTitle(agent);
    const resolvedBody = body || buildDefaultPullRequestBody(agent, base);

    if (source === 'default') {
      log.info(
        {
          agentId: agent.agentId,
          source,
          titlePreview: resolvedTitle.slice(0, 80),
          usedCommitMessage: !!agent.commitMessage?.trim(),
          usedPrompt: !!agent.prompt?.trim(),
        },
        'Using default PR title and body',
      );
    }

    return {
      title: resolvedTitle,
      body: resolvedBody,
    };
  }

  async function createPullRequest(
    agentId: string,
    prOptions: { title?: string; body?: string } = {},
  ): Promise<Agent> {
    const agent = repository.getAgent(agentId);

    if (agent.pullRequest) {
      throw new CodedError('Pull request already exists for this session', 'PR_EXISTS');
    }

    if (!canCreatePullRequest(agent)) {
      throw new CodedError(
        'Pull request can only be created after OpenCode completes successfully with a pushed branch',
        'PR_NOT_READY',
      );
    }

    const repo = repoManager.getRepo(agent.repoId);
    const config = configRepository.load();
    githubApp.assertConfigured(config);

    const headBranch = agent.agentBranch || agent.branch;
    if (!headBranch) {
      throw new CodedError('Agent branch is missing', 'PR_NOT_READY');
    }

    const base = agent.useExistingBranch
      ? repo.defaultBranch || 'main'
      : agent.baseBranch || repo.defaultBranch || 'main';

    const { title, body } = await resolvePullRequestContent(
      agent,
      base,
      repo.owner,
      repo.name,
      prOptions,
    );

    let githubPr;
    try {
      githubPr = await githubApp.createPullRequest(config, {
        owner: repo.owner,
        repo: repo.name,
        title,
        head: headBranch,
        base,
        body,
      });
    } catch (err) {
      const message = getErrorMessage(err);
      if (/already exists|pull request already/i.test(message)) {
        const existing = await githubApp.findPullRequestByHead(
          config,
          repo.owner,
          repo.name,
          headBranch,
        );
        if (existing) {
          githubPr = existing;
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }

    const pullRequest = mapGitHubPullRequest(githubPr);
    const updated = repository.update(agentId, { pullRequest });
    if (!updated) {
      throw new CodedError('Agent not found', 'NOT_FOUND');
    }
    return updated;
  }

  async function refreshPullRequest(agentId: string): Promise<Agent> {
    const agent = repository.getAgent(agentId);

    if (!agent.pullRequest) {
      throw new CodedError('No pull request linked to this session', 'PR_NOT_FOUND');
    }

    const repo = repoManager.getRepo(agent.repoId);
    const config = configRepository.load();
    githubApp.assertConfigured(config);

    const githubPr = await githubApp.getPullRequest(
      config,
      repo.owner,
      repo.name,
      agent.pullRequest.number,
    );

    const pullRequest = mapGitHubPullRequest(githubPr);
    const updated = repository.update(agentId, { pullRequest });
    if (!updated) {
      throw new CodedError('Agent not found', 'NOT_FOUND');
    }
    return updated;
  }

  function restoreOnStartup(): void {
    const agents = repository.findAll();
    let changed = false;

    for (const agent of agents) {
      const mode = getAgentMode(agent);
      const activeStatuses =
        mode === 'interactive'
          ? INTERACTIVE_ACTIVE_STATUSES
          : mode === 'loop'
            ? LOOP_ACTIVE_STATUSES
            : BATCH_ACTIVE_STATUSES;
      if (activeStatuses.has(agent.status)) {
        agent.status = 'failed';
        agent.finishedAt = new Date().toISOString();
        agent.error = 'Server restarted while agent was in progress';
        if (mode === 'interactive') {
          agent.interactive = buildInteractiveState('failed');
        }
        if (mode === 'loop') {
          agent.loop = buildLoopState('failed', agent.loop, agent);
        }
        changed = true;
      }
    }

    if (changed) {
      repository.saveAll(agents);
    }
  }

  return {
    createAgent,
    getAgent: (agentId) => repository.getAgent(agentId),
    listAgents: (filters) => repository.list(filters),
    readLogs: (agentId, tailLines) => repository.readLogs(agentId, tailLines),
    readEvents: (agentId, sinceSeq) => repository.readEvents(agentId, sinceSeq),
    getLastEventSeq: (agentId) => repository.getLastEventSeq(agentId),
    readMessages: (agentId) => repository.readMessages(agentId),
    sendMessage,
    finishAgent,
    commitOutstandingChanges,
    cancelAgent,
    deleteAgent,
    cleanupOldWorkspaces,
    createPullRequest,
    refreshPullRequest,
    restoreOnStartup,
    shutdown: () => {
      queue.clear();
      return spawner.shutdown();
    },
    maxConcurrent,
    agentTimeoutMs,
  };
}

/** @deprecated Use createAgentService */
export const createAgentManager = createAgentService;

export type AgentManager = AgentService;
