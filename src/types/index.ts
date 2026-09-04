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

export interface AppConfig {
  ollamaBaseUrl: string;
  opencodeModel: string;
  opencodeProvider: string;
  systemPrompt: string;
  githubAppId: string;
  githubAppInstallationId: string;
  githubAppPrivateKey: string;
  gitUserName: string;
  gitUserEmail: string;
  webhookUrl: string;
  /** Default true — batch agents auto-approve OpenCode tool permissions */
  batchAutoApprovePermissions: boolean;
  /** Default true — loop agents auto-approve OpenCode tool permissions */
  loopAutoApprovePermissions: boolean;
  /** Default false — interactive agents require permission approval unless overridden */
  interactiveAutoApprovePermissions: boolean;
  /** Auto-create PR when agent completes */
  autoCreatePullRequest?: boolean;
  /** Default false — auto-spawn review agent after PR creation for completed agents */
  autoReviewPullRequests?: boolean;
  /** Model for code review (falls back to opencodeModel) */
  reviewModel: string;
  /** Interactive agent timeout in seconds (default 3600) */
  interactiveAgentTimeoutSeconds: number;
  /** Loop agent timeout in seconds (default 3600) */
  loopAgentTimeoutSeconds: number;
  /** Per-verb model overrides for loop mode. Empty string = use fallback. */
  loopVerbModels: LoopVerbModels;
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
  opencodeModel: string;
  opencodeProvider: string;
  systemPrompt: string | null;
  githubAppId: string;
  githubAppInstallationId: string;
  githubAppPrivateKey: string;
  hasGithubAppPrivateKey: boolean;
  gitUserName: string;
  gitUserEmail: string;
  webhookUrl: string;
  batchAutoApprovePermissions: boolean;
  loopAutoApprovePermissions: boolean;
  interactiveAutoApprovePermissions: boolean;
  autoCreatePullRequest?: boolean;
  autoReviewPullRequests?: boolean;
  reviewModel: string;
  interactiveAgentTimeoutSeconds: number;
  loopAgentTimeoutSeconds: number;
  loopVerbModels: LoopVerbModels;
  /** Bundled server default from config/loop.default.json */
  loopDefaultMaxIterations: number;
}

export interface OllamaModel {
  name: string;
  size?: number;
  modifiedAt?: string;
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

export type AgentMode = 'batch' | 'interactive' | 'loop' | 'review';

export type LoopVerb = 'INITIAL_PLAN' | 'ORIENT' | 'ACT' | 'REFLECT';

export type LoopVerbModels = Partial<Record<LoopVerb, string>>;

export const LOOP_VERB_MODELS_DEFAULT: LoopVerbModels = {
  INITIAL_PLAN: '',
  ORIENT: '',
  ACT: '',
  REFLECT: '',
};

export type LoopOpenCodeAgent = 'build' | 'plan';

export interface LoopStepConfig {
  verb: LoopVerb;
  prompt: string;
  /** OpenCode agent profile. Defaults: ORIENT/REFLECT → plan (read-only), ACT → build. */
  agent?: LoopOpenCodeAgent;
}

export interface RepoPromptOverrides {
  systemPrompt?: string;
  batchContextPrompt?: string;
  interactiveContextPrompt?: string;
  loopContextPrompt?: string;
  reviewBackground?: string;
  /** Shell command the host runs after each ACT step in loop mode (e.g. `npm test`). */
  checkCommand?: string;
}

/** Milestone progress mirrored from loop handoff state for API/UI. */
export interface AgentLoopHandoffState {
  next: string | null;
  remaining: string | null;
  milestonesTotal: number;
  milestonesDone: number;
  currentMilestone: string | null;
  lastFiles: string[];
}

export interface AgentLoopState {
  iteration: number;
  stepIndex: number;
  currentVerb: LoopVerb;
  stepsInIteration: number;
  maxIterations: number;
  completionMarker: string;
  canFinish: boolean;
  /** Failed loop sessions with uncommitted workspace changes can salvage via commit. */
  canCommitOutstanding: boolean;
  finishRequested: boolean;
  configSource: 'server-default' | 'repo-override';
  effectiveSteps: LoopStepConfig[];
  /** Host-maintained handoff slice for milestone progress (loop mode only). */
  handoff?: AgentLoopHandoffState;
}

export type AgentStatus =
  | 'queued'
  | 'running'
  | 'awaiting_input'
  | 'processing'
  | 'completing'
  | 'completed'
  | 'failed'
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
  | 'log.line'
  | 'loop.step.start'
  | 'loop.step.end'
  | 'loop.iteration.end';

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

export interface AgentInteractiveState {
  canSendMessage: boolean;
  canFinish: boolean;
  pendingPermissionId: string | null;
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
}

/** `setup` block of the repo's .localagent-box/environment.json */
export interface RepoEnvironmentSetupConfig {
  command: string;
  timeoutMs?: number;
  /** Default true — a non-zero exit fails the agent (applied at runtime) */
  failOnError?: boolean;
  /**
   * Modes for which the setup runs (P4-T3). When set and the agent's mode is
   * not listed, the bootstrap is skipped for that run.
   */
  runOnModes?: AgentMode[];
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
   * A failure always fails the bootstrap, regardless of `setup.failOnError`.
   */
  verifyCommand?: string;
  /**
   * Timeout for the verify command (P4-T2). Defaults to the setup timeout
   * (or `DEFAULT_SETUP_TIMEOUT_MS` when the setup block has none).
   */
  verifyTimeoutMs?: number;
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
  /** Last ~50 lines of command output (same cap as loop checks) */
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

export interface Agent {
  agentId: string;
  workspaceId: string;
  repoId: string;
  /** Defaults to 'batch' when omitted in persisted records */
  mode?: AgentMode;
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
  /** Per-verb model overrides for this loop run (create-time snapshot) */
  loopVerbModels?: LoopVerbModels;
  /** Per-session iteration cap for loop mode (create-time snapshot); omitted = global/repo default */
  loopMaxIterations?: number;
  /** Distinct models actually invoked during a loop run's lifecycle */
  modelsUsed?: string[] | null;
  status: AgentStatus;
  /** Present only when mode === 'interactive' */
  opencodeSessionId?: string | null;
  turnCount?: number;
  lastActivityAt?: string | null;
  awaitingInputSince?: string | null;
  messagesPreview?: string | null;
  /** Snapshot of working tree changes at the last awaiting_input checkpoint */
  gitStatus?: AgentGitStatus | null;
  interactive?: AgentInteractiveState;
  /** Present when mode === 'loop' */
  loop?: AgentLoopState;
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
  commitMessage: string;
  push: boolean;
  pushOnFailure: boolean;
  /** When set, overrides mode default from Settings for OpenCode tool permissions */
  autoApprovePermissions?: boolean;
  model?: string;
  /** Per-verb model overrides for this loop run */
  loopVerbModels?: LoopVerbModels;
  /** Per-session iteration cap for loop mode (create-time snapshot); omitted = global/repo default */
  loopMaxIterations?: number;
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

export interface AgentReviewMetadata {
  baseBranch: string | null;
  headBranch: string | null;
  background?: string | null;
  ocrResultPath?: string | null;
  githubReviewId?: string | null;
  headSha?: string | null;
  prNumber?: number | null;
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
