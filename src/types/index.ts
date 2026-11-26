import type { IncomingMessage, ServerResponse } from 'http';
import type { ChildProcess } from 'child_process';
import type { ConfigStore } from '../services/config-store';
import type { JsonStore } from '../lib/json-store';
import type { OpenCodeConfigService } from '../services/opencode-config';
import type { OllamaProbe } from '../services/ollama-probe';
import type { GithubAppService } from '../services/github-app';
import type { GitService } from '../services/git-service';
import type { OllamaChatService } from '../services/ollama-client';
import type { RepoService } from '../domains/repos/repo.service';
import type { AgentService } from '../domains/agents/agent.service';
import type { ConfigRepository } from '../domains/config/config.repository';
import type { GitChangedFile } from './git-file-change';

export type { GitChangedFile, GitFileChangeKind } from './git-file-change';
export type AgentGitChangedFile = GitChangedFile;

export const LLM_PROVIDER_IDS = ['ollama', 'ollama-cloud', 'openai-compatible'] as const;
export type LlmProviderId = (typeof LLM_PROVIDER_IDS)[number];

export const DEFAULT_OLLAMA_CLOUD_BASE_URL = 'https://ollama.com';

export interface AppConfig {
  ollamaBaseUrl: string;
  ollamaCloudApiKey: string;
  /** Empty → DEFAULT_OLLAMA_CLOUD_BASE_URL */
  ollamaCloudBaseUrl: string;
  /** Any OpenAI-compatible server (Strata, LM Studio, vLLM, llama.cpp); `/v1` is appended when missing. */
  openaiCompatibleBaseUrl: string;
  /** Optional — sent as a Bearer token when set. */
  openaiCompatibleApiKey: string;
  opencodeModel: string;
  opencodeProvider: LlmProviderId;
  /** Empty → inherit opencodeProvider */
  reviewProvider: LlmProviderId | '';
  systemPrompt: string;
  githubAppId: string;
  githubAppInstallationId: string;
  githubAppPrivateKey: string;
  gitUserName: string;
  gitUserEmail: string;
  webhookUrl: string;
  /** Default true — batch agents auto-approve OpenCode tool permissions */
  batchAutoApprovePermissions: boolean;
  /** Auto-create PR when agent completes */
  autoCreatePullRequest?: boolean;
  /** Default false — auto-spawn review agent after PR creation for completed agents */
  autoReviewPullRequests?: boolean;
  /** Model for code review (falls back to opencodeModel) */
  reviewModel: string;
  /** Default false — skip the workspace bootstrap for review runs */
  ocrSkipWorkspaceBootstrap?: boolean;
  /**
   * Token costs per model in USD per 1,000,000 tokens. Keys are model ids
   * (`llama3.2` or `ollama/llama3.2`). Ollama reports no cost amounts, so session
   * cost is computed from usage using these rates; models without an entry cost 0.
   */
  modelTokenCosts?: ModelTokenCosts;
  /**
   * Workspace bootstrap run from the worker process (P2-T4). These keys may be
   * set in `config.json`; in a worker sandbox that file rarely exists, so
   * `bootstrapAutoDetect` and `globalSetupTimeoutMs` are additionally hydrated
   * from the operator environment (`BOOTSTRAP_AUTO_DETECT`,
   * `BOOTSTRAP_SETUP_TIMEOUT_MS`) at worker context creation (see
   * `createWorkerContext`). Env values are never persisted and a valid
   * `config.json` value wins over the env.
   */
  /** Explicit profile names enabled for bootstrap resolution; omitted/empty = all catalog profiles. */
  enabledRuntimeProfiles?: string[];
  /** Default false — run lockfile auto-detect even without `.localagent-box/environment.json`. */
  bootstrapAutoDetect?: boolean;
  /** Global override for `setup.timeoutMs` in ms; ignored when non-positive. */
  globalSetupTimeoutMs?: number;
}

export type ConfigPartial = Partial<AppConfig>;

export interface PublicConfig {
  ollamaBaseUrl: string;
  ollamaCloudApiKey: string;
  ollamaCloudBaseUrl: string;
  hasOllamaCloudApiKey: boolean;
  openaiCompatibleBaseUrl: string;
  openaiCompatibleApiKey: string;
  hasOpenaiCompatibleApiKey: boolean;
  opencodeModel: string;
  opencodeProvider: LlmProviderId;
  reviewProvider: LlmProviderId | '';
  systemPrompt: string | null;
  githubAppId: string;
  githubAppInstallationId: string;
  githubAppPrivateKey: string;
  hasGithubAppPrivateKey: boolean;
  gitUserName: string;
  gitUserEmail: string;
  webhookUrl: string;
  batchAutoApprovePermissions: boolean;
  autoCreatePullRequest?: boolean;
  autoReviewPullRequests?: boolean;
  reviewModel: string;
  ocrSkipWorkspaceBootstrap?: boolean;
  modelTokenCosts?: ModelTokenCosts;
}

export interface OllamaModel {
  name: string;
  size?: number;
  modifiedAt?: string;
  /** Context window in tokens, when the server reports one. */
  contextLength?: number;
}

export interface OllamaProbeResult {
  status: string;
  reachable: boolean;
  message?: string;
  url?: string;
  modelCount?: number;
  models?: OllamaModel[];
}

export type AutofixSeverityThreshold =
  | 'disabled'
  | 'critical'
  | 'high'
  | 'medium'
  | 'low';

export interface RepoAutofixSettings {
  severityThreshold: AutofixSeverityThreshold;
  maxFindingsPerBatch: number;
}

export const AUTOFIX_SEVERITY_THRESHOLDS: readonly AutofixSeverityThreshold[] = [
  'disabled',
  'critical',
  'high',
  'medium',
  'low',
];

export const DEFAULT_REPO_AUTOFIX_SETTINGS: RepoAutofixSettings = {
  severityThreshold: 'disabled',
  maxFindingsPerBatch: 5,
};

export type ReviewFindingFixStatus =
  | 'available'
  | 'assigned'
  | 'fixing'
  | 'fixed'
  | 'failed';

export type ReviewFindingResolutionStatus =
  | 'not_applicable'
  | 'pending'
  | 'resolved'
  | 'failed';

export interface ReviewFindingRecord {
  id: string;
  ordinal: number;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'unknown';
  category: string | null;
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  content: string;
  existingCode: string | null;
  suggestionCode: string | null;
  reviewedSha: string | null;
  fixStatus: ReviewFindingFixStatus;
  assignedAgentId: string | null;
  fixedAt: string | null;
  github: {
    reviewId: string | null;
    commentId: number | null;
    commentUrl: string | null;
    threadId: string | null;
    resolutionStatus: ReviewFindingResolutionStatus;
      resolutionError: string | null;
      resolvedAt: string | null;
    };
}

export interface ReviewAutofixSnapshot {
  severityThreshold: AutofixSeverityThreshold;
  maxFindingsPerBatch: number;
  reviewedSha: string | null;
  baseBranch: string;
  headBranch: string;
  prNumber: number | null;
  snapshottedAt: string;
}

export interface AutofixBatchPlan {
  index: number;
  findingIds: string[];
  agentId: string | null;
  status: 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'skipped';
}

export interface ReviewAutofixPlan {
  schemaVersion: 1;
  snapshot: ReviewAutofixSnapshot;
  chainStatus: 'disabled' | 'running' | 'paused' | 'completed';
  batches: AutofixBatchPlan[];
  nextBatchIndex: number | null;
  verification: {
    status: 'none' | 'pending' | 'queued' | 'running' | 'completed' | 'failed';
    agentId: string | null;
  };
}

export interface Repo {
  repoId: string;
  owner: string;
  name: string;
  defaultBranch: string;
  cloneUrl: string;
  registeredAt: string;
  lastVerifiedAt: string | null;
  lastVerifyStatus: string | null;
  lastVerifyMessage: string | null;
  autoReviewPullRequests: boolean | null;
  autofix?: RepoAutofixSettings;
  /** Per-repo webhook endpoint; null/empty falls back to the global `webhookUrl` */
  webhookUrl?: string | null;
}

export interface AgentAutofixMetadata {
  kind: 'automatic' | 'manual';
  sourceReviewAgentId: string;
  findingIds: string[];
  batchIndex?: number;
}

export interface AgentResult {
  branch: string;
  baseBranch: string;
  workspaceId: string;
  commitSha: string | null;
  pushed: boolean;
  filesChanged: number;
  warning: string | null;
  opencodeSuccess: boolean;
}

export type AgentMode = 'batch' | 'review';

/** Modes removed in v1. Pre-v1 records may still carry them and are read-only. */
export type LegacyAgentMode = 'interactive' | 'loop';

export type RepoReviewRiskLevel = 'critical' | 'high' | 'medium' | 'low';

export type RepoReviewEffort = 'low' | 'medium' | 'high';

/** A part of the codebase the reviewer should scrutinise more closely. */
export interface RepoReviewRiskArea {
  /** Gitignore-style globs; omitted means the risk applies across the codebase. */
  paths?: string[];
  description: string;
  risk?: RepoReviewRiskLevel;
}

/** `review` block of `.localagent-box/config.json`. */
export interface RepoReviewConfig {
  /** Free-text review instructions. Legacy top-level `reviewBackground` maps here. */
  background?: string;
  riskAreas?: RepoReviewRiskArea[];
  /** Passed to OCR `--exclude`, merged with `.opencodereview/rule.json` excludes. */
  exclude?: string[];
  /** Passed to OCR `--effort`. */
  effort?: RepoReviewEffort;
  /** When true, the built-in DEFAULT_REVIEW_RULES are left out of the background. */
  replaceDefaultRules?: boolean;
}

export interface RepoPromptOverrides {
  systemPrompt?: string;
  batchContextPrompt?: string;
  /** Legacy alias for `review.background`; validation copies it there. */
  reviewBackground?: string;
  review?: RepoReviewConfig;
}

export type AgentStatus =
  | 'queued'
  | 'running'
  /** Legacy only: pre-v1 interactive sessions; no run can set it any more */
  | 'awaiting_input'
  | 'processing'
  /** Host-run post-run checks are executing (v1 1.1) */
  | 'verifying'
  /** A repair turn requested after a failing check (v1 1.2) */
  | 'repairing'
  | 'completing'
  | 'completed'
  | 'failed'
  /** Checks still failing after the repair attempts were used up (v1 1.2) */
  | 'needs_attention'
  /** Failed because of the machine (timeout, OOM, disk), not because of the code */
  | 'failed_machine'
  | 'cancelled';

export type AgentQueueWaitingOn = 'predecessor' | 'slot' | 'branch_worker';

export interface AgentQueueState {
  position: number | null;
  waitingOn: AgentQueueWaitingOn | null;
  predecessorId: string | null;
  predecessorStatus: AgentStatus | null;
  reason: string | null;
  canRetry: boolean;
  canAllowSuccessors: boolean;
}

export type AgentEventType =
  | 'session.status'
  | 'assistant.delta'
  | 'assistant.message'
  | 'tool.start'
  | 'tool.end'
  | 'permission.requested'
  | 'error'
  | 'log.line';

export interface AgentEvent {
  seq: number;
  ts: string;
  type: AgentEventType;
  sessionId?: string;
  payload: Record<string, unknown>;
}

export interface AgentMessage {
  ts: string;
  role: 'user' | 'assistant';
  text: string;
}

export interface AgentGitStatus {
  filesChanged: number;
  files: GitChangedFile[];
  updatedAt: string;
}

export type AgentPullRequestState = 'open' | 'closed' | 'merged';

export interface AgentPullRequest {
  number: number;
  url: string;
  state: AgentPullRequestState;
  title: string;
  createdAt: string;
  mergedAt: string | null;
  updatedAt: string;
}

export interface AgentTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
  /** True when any part of `cost` was computed from configured `modelTokenCosts` rates rather than reported by the provider. */
  costEstimated?: boolean;
}

/** Per-category token rates in USD per 1,000,000 tokens. Missing categories cost nothing. */
export interface ModelTokenCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Model id (or `provider/model`) → token rates. Models without an entry cost 0. */
export type ModelTokenCosts = Record<string, ModelTokenCost>;

/** `setup` block of the repo's .localagent-box/environment.json */
export interface RepoEnvironmentSetupConfig {
  command: string;
  timeoutMs?: number;
  /**
   * Default false — a failed setup/verify is recorded and fed to the agent's
   * prompt for a fix attempt; `true` fails the agent start (applied at runtime)
   */
  failOnError?: boolean;
  /**
   * Modes for which the setup runs (P4-T3). When set and the agent's mode is
   * not listed, the bootstrap is skipped for that run.
   */
  runOnModes?: AgentMode[];
}

/** Post-run host checks in the `checks` block of `environment.json` (v1 1.1). */
export interface RepoCheckConfig {
  build?: string;
  lint?: string;
  test?: string;
  /** Defaults to `verifyTimeoutMs`, then 600000. */
  timeoutMs?: number;
}

/**
 * Parsed .localagent-box/environment.json content.
 * Unknown top-level keys are ignored by the loader.
 */
export interface RepoEnvironmentConfig {
  /** Currently supported schema version */
  version: 1;
  setup?: RepoEnvironmentSetupConfig;
  /** Explicit profile names; the first enabled profile's defaultSetup is run */
  profiles?: string[];
  /** Opt out of lockfile auto-detection; defaults to true */
  autoDetect?: boolean;
  /**
   * Explicit dependency-cache key (P3-T6). When set, the cache entry under
   * `{dep-cache-root}/{repoId}` is addressed by this key (sanitized to
   * alphanumerics + hyphens) instead of a hash of the lockfile contents.
   */
  cacheKey?: string;
  /**
   * Post-setup smoke test run after a successful setup command (P4-T2).
   * A failure is handled per `setup.failOnError`: recorded + fed to the
   * agent by default, or fails the bootstrap when `true`.
   */
  verifyCommand?: string;
  /**
   * Timeout for the verify command (P4-T2). Defaults to the setup timeout
   * (or `DEFAULT_SETUP_TIMEOUT_MS` when the setup block has none).
   */
  verifyTimeoutMs?: number;
  /**
   * Host-run checks after the model's turn (v1 1.1), read from the base branch
   * so a run cannot change the checks it is verified under.
   */
  checks?: RepoCheckConfig;
  /** Repair turns allowed after a failing check, 0–3, default 2 (v1 1.2) */
  repairAttempts?: number;
  /** Allow a draft PR when checks fail; default false (v1 1.2) */
  draftPrOnFailure?: boolean;
}

export type BootstrapStatus = 'skipped' | 'running' | 'completed' | 'failed';

/** Where the bootstrap setup command came from. */
export type AgentBootstrapSource = 'script' | 'explicit' | 'profile' | 'detect' | 'none';

/**
 * Host bootstrap result state; persisted on the Agent record (P1-T5).
 * `profiles` / `source` are set whenever a setup command is resolved
 * (P2-T3): phase-2 detection/profiling, or phase-1 explicit `setup.command`.
 */
export interface AgentBootstrapState {
  status: BootstrapStatus;
  /** Setup command resolved and run (or run pending when `status === 'running'`) */
  command?: string;
  /** Profile name(s) resolved to the command; `[]` for explicit / `'none'` */
  profiles?: string[];
  /** How the command was resolved; omitted when nothing was resolved */
  source?: AgentBootstrapSource;
  durationMs?: number;
  exitCode?: number;
  /** Last ~50 lines of command output (same cap as host-run checks) */
  outputTail?: string;
  error?: string;
  /**
   * Whether the workspace dependencies were restored from the persistent
   * dependency cache before the setup command ran (P3-T4). Omitted when the
   * cache is disabled.
   */
  cacheHit?: boolean;
  /** Post-setup smoke test command run after a successful setup (P4-T2) */
  verifyCommand?: string;
  /**
   * Exit code of the post-setup verify command (P4-T2). Omitted when no
   * `verifyCommand` was configured or has not run yet.
   */
  verifyExitCode?: number;
}

/** Names of the host-run post-turn checks (v1 1.1). */
export type CheckName = 'build' | 'lint' | 'test' | 'verify';

/** One host-run check: the exit status plus the output tail the host keeps. */
export interface AgentCheckRun {
  name: CheckName;
  command: string;
  exitCode: number;
  /** Signal the process died on (string, not NodeJS.Signals, so the record stays JSON-safe). */
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  outputTail: string;
}

/**
 * One verification pass over the workspace: `attempt` 0 is after the task turn,
 * 1..n after repair n. Checks stop at the first failure.
 */
export interface AgentVerificationAttempt {
  attempt: number;
  startedAt: string;
  finishedAt: string;
  checks: AgentCheckRun[];
  passed: boolean;
  failureKind?: 'code' | 'machine';
  machineReason?: string;
  /** Filled by 1.5 */
  diffStat?: string;
  /** Filled by 1.5 (truncated to 4000 chars) */
  assistantText?: string;
}

/** Host-run verification state for the run, persisted on the agent record. */
export interface AgentVerification {
  state: 'unverified' | 'passed' | 'failed' | 'machine_failure';
  /** Where the check config came from; checks are never read from the working tree. */
  configSource: 'base' | 'none';
  maxRepairAttempts: number;
  /**
   * Resolved `draftPrOnFailure`, kept on the record so the server can decide about
   * a draft PR without the workspace (v1 1.2).
   */
  draftPrOnFailure?: boolean;
  attempts: AgentVerificationAttempt[];
}

export interface Agent {
  agentId: string;
  workspaceId: string;
  repoId: string;
  /** Defaults to 'batch' when omitted in persisted records; legacy records keep a removed mode */
  mode?: AgentMode | LegacyAgentMode;
  prompt: string;
  systemPrompt: string | null;
  baseBranch: string;
  agentBranch: string;
  /** When true, clone and checkout agentBranch instead of creating a new branch from baseBranch */
  useExistingBranch?: boolean;
  commitMessage: string;
  push: boolean;
  pushOnFailure: boolean;
  /** When set, overrides mode default from Settings for OpenCode tool permissions */
  autoApprovePermissions?: boolean;
  model: string | null;
  /** Distinct models invoked during the run (read by PR content generation) */
  modelsUsed?: string[] | null;
  status: AgentStatus;
  /** Repair turn in progress (1-based); set when a code failure sends the model back to work */
  repairAttempt?: number;
  /** Legacy interactive-session fields; kept so pre-v1 records still read */
  opencodeSessionId?: string | null;
  turnCount?: number;
  lastActivityAt?: string | null;
  awaitingInputSince?: string | null;
  messagesPreview?: string | null;
  /** Snapshot of working tree changes at the last checkpoint */
  gitStatus?: AgentGitStatus | null;
  commitSha: string | null;
  pushed: boolean;
  filesChanged: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  branch: string | null;
  error: string | null;
  result: AgentResult | null;
  pullRequest?: AgentPullRequest | null;
  /** Auto-create PR when agent completes */
  autoCreatePullRequest?: boolean;
  /** When true on a failed/cancelled session, later sessions on the same branch may start. */
  allowSuccessors?: boolean;
  /** Links auto-spawned review to the coding agent that completed */
  parentAgentId?: string | null;
  /** Review-specific metadata; present only when mode === 'review' */
  review?: AgentReviewMetadata | null;
  /** Autofix orchestration metadata; present when this batch agent fixes review findings */
  autofix?: AgentAutofixMetadata | null;
  /** Cumulative token usage across all assistant messages in this session */
  tokenUsage?: AgentTokenUsage;
  /** Host-run workspace bootstrap (setup command) before the agent starts */
  bootstrap?: AgentBootstrapState;
  /** Host-run checks after the model's turn (v1 1.1) */
  verification?: AgentVerification | null;
  /** Derived wait/retry info; not persisted */
  queue?: AgentQueueState;
}

export interface AgentJob {
  agentId: string;
  workspaceId: string;
  repoId: string;
  /** Default 'batch' in worker if missing (legacy job.json) */
  mode?: AgentMode;
  prompt: string;
  systemPrompt?: string;
  baseBranch: string;
  agentBranch: string;
  /** When true, clone and checkout agentBranch instead of creating a new branch from baseBranch */
  useExistingBranch?: boolean;
  /**
   * Branch the post-run check config is read from (v1 1.1): the repo default
   * when the run works on an existing branch, otherwise `baseBranch`.
   */
  checksBaseBranch: string;
  commitMessage: string;
  push: boolean;
  pushOnFailure: boolean;
  /** When set, overrides mode default from Settings for OpenCode tool permissions */
  autoApprovePermissions?: boolean;
  model?: string;
  /** Review mode head branch (set by worker-spawner when mode is 'review') */
  headBranch?: string;
  /** Review mode background context */
  background?: string | null;
  agentTimeoutMs: number;
  dataDir: string;
  workspaceRoot: string;
  workspaceDir: string;
  logPath: string;
}

export interface ServerContext {
  configStore: ConfigStore;
  configRepository: ConfigRepository;
  reposStore: JsonStore<{ repos: Repo[] }>;
  agentsStore: JsonStore<{ agents: Agent[] }>;
  opencodeConfig: OpenCodeConfigService;
  ollamaProbe: OllamaProbe;
  ollamaChat: OllamaChatService;
  githubApp: GithubAppService;
  gitService: GitService;
  repoManager: RepoService;
  agentManager: AgentService;
}

export interface Route {
  match: (method: string | undefined, pathname: string) => boolean;
  handle: (req: IncomingMessage, res: ServerResponse, ctx: ServerContext) => Promise<void>;
}

export class CodedError extends Error {
  code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'CodedError';
    this.code = code;
  }
}

export function getErrorCode(err: unknown): string | undefined {
  if (err instanceof CodedError) {
    return err.code;
  }
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

export type AgentReviewCheckConclusion =
  | 'success'
  | 'action_required'
  | 'failure'
  | 'cancelled';

export interface AgentReviewMetadata {
  baseBranch: string | null;
  headBranch: string | null;
  background?: string | null;
  ocrResultPath?: string | null;
  githubReviewId?: string | null;
  headSha?: string | null;
  prNumber?: number | null;
  /** Check run created for this review on the PR head SHA (Checks API). */
  githubCheckRunId?: number | null;
  /** Commit SHA the check run was created against. */
  githubCheckHeadSha?: string | null;
  /** Latest conclusion PATCHed to the check run, when completed. */
  githubCheckConclusion?: AgentReviewCheckConclusion | null;
  /** 'verification' marks an autofix verification review. */
  purpose?: 'standard' | 'verification';
  /** Source review this verification review validates. */
  sourceReviewAgentId?: string;
  /** Verification reviews never start an automatic fix chain. */
  autofixIneligible?: boolean;
}

export interface ReviewJobFields {
  baseBranch: string;
  headBranch: string;
  background?: string;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options?: import('child_process').SpawnOptions,
) => ChildProcess;
