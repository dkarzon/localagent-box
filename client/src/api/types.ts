export type StatusVariant = '' | 'success' | 'error';

export type AgentMode = 'batch' | 'review';

/** Modes removed in v1. Older records still carry them and render read-only. */
export type LegacyAgentMode = 'interactive' | 'loop';

export type AgentStatus =
  | 'queued'
  | 'running'
  /** Legacy only: pre-v1 interactive sessions; no run can set it */
  | 'awaiting_input'
  | 'processing'
  /** Host-run post-run checks are running */
  | 'verifying'
  /** A repair turn requested after a failing check */
  | 'repairing'
  | 'completing'
  | 'completed'
  | 'failed'
  /** Checks still failing after the repair attempts were used up */
  | 'needs_attention'
  /** Stopped by a machine failure (timeout, OOM, disk), not by the code */
  | 'failed_machine'
  | 'cancelled';

export type AgentQueueWaitingOn = 'predecessor' | 'slot' | 'branch_worker';

export interface AgentQueueState {
  position: number | null;
  waitingOn: AgentQueueWaitingOn | null;
  predecessorId: string | null;
  predecessorStatus: AgentStatus | string | null;
  reason: string | null;
  canRetry: boolean;
  canAllowSuccessors: boolean;
}

export interface OllamaModel {
  name: string;
  size?: number;
  modifiedAt?: string;
  contextLength?: number;
}

export interface OllamaStatus {
  status?: string;
  reachable?: boolean;
  message?: string;
  url?: string;
  modelCount?: number;
  models?: OllamaModel[];
}

export const LLM_PROVIDER_IDS = ['ollama', 'ollama-cloud', 'openai-compatible'] as const;
export type LlmProviderId = (typeof LLM_PROVIDER_IDS)[number];

export const LLM_PROVIDER_LABELS: Record<LlmProviderId, string> = {
  ollama: 'Ollama (local)',
  'ollama-cloud': 'Ollama Cloud',
  'openai-compatible': 'OpenAI-compatible',
};

export interface HealthResponse {
  ollama?: OllamaStatus;
  providers?: Partial<Record<LlmProviderId, OllamaStatus>>;
}

export interface AppConfig {
  ollamaBaseUrl?: string;
  ollamaCloudApiKey?: string;
  ollamaCloudBaseUrl?: string;
  hasOllamaCloudApiKey?: boolean;
  openaiCompatibleBaseUrl?: string;
  openaiCompatibleApiKey?: string;
  hasOpenaiCompatibleApiKey?: boolean;
  opencodeModel?: string;
  opencodeProvider?: LlmProviderId;
  reviewProvider?: LlmProviderId | '';
  /** Default system prompt for agents, unless overridden per-repo or per-agent. Empty string is sent as `null` in GET. */
  systemPrompt?: string | null;
  githubAppId?: string;
  githubAppInstallationId?: string;
  hasGithubAppPrivateKey?: boolean;
  gitUserName?: string;
  gitUserEmail?: string;
  webhookUrl?: string;
  batchAutoApprovePermissions?: boolean;
  /** Per-model token rates in USD per 1,000,000 tokens. Models without an entry cost 0. */
  modelTokenCosts?: ModelTokenCosts;
  /** When true (default), auto-create a PR once an agent completes and pushes. Per-agent create request can override. */
  autoCreatePullRequest?: boolean;
  autoReviewPullRequests?: boolean;
  reviewModel?: string;
  /** When true, review runs skip the workspace bootstrap. Default false. */
  ocrSkipWorkspaceBootstrap?: boolean;
  ollama?: OllamaStatus;
  opencode?: { path?: string };
}

export interface GithubStatus {
  configured?: boolean;
  gitUserConfigured?: boolean;
}

export type AutofixSeverityThreshold = 'disabled' | 'critical' | 'high' | 'medium' | 'low';

export interface RepoAutofixSettings {
  severityThreshold: AutofixSeverityThreshold;
  maxFindingsPerBatch: number;
}

export type ReviewFindingFixStatus = 'available' | 'assigned' | 'fixing' | 'fixed' | 'failed';

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

export interface ReviewAutofixPlan {
  schemaVersion: 1;
  snapshot: {
    severityThreshold: AutofixSeverityThreshold;
    maxFindingsPerBatch: number;
    reviewedSha: string | null;
    baseBranch: string;
    headBranch: string;
    prNumber: number | null;
    snapshottedAt: string;
  };
  chainStatus: 'disabled' | 'running' | 'paused' | 'completed';
  batches: Array<{
    index: number;
    findingIds: string[];
    agentId: string | null;
    status: 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'skipped';
  }>;
  nextBatchIndex: number | null;
  verification: {
    status: 'none' | 'pending' | 'queued' | 'running' | 'completed' | 'failed';
    agentId: string | null;
  };
}

export interface AgentFindingsResponse {
  agentId: string;
  findings: ReviewFindingRecord[];
  plan: ReviewAutofixPlan | null;
  currentHeadSha: string | null;
  staleReview: boolean;
  verificationAgentId: string | null;
}

export interface Repo {
  repoId: string;
  owner: string;
  name: string;
  defaultBranch: string;
  cloneUrl?: string;
  registeredAt?: string;
  lastVerifiedAt?: string;
  lastVerifyStatus?: string;
  lastVerifyMessage?: string;
  autoReviewPullRequests?: boolean | null;
  autofix?: RepoAutofixSettings;
  webhookUrl?: string | null;
}

export interface AgentReviewMetadata {
  baseBranch?: string | null;
  headBranch?: string | null;
  background?: string | null;
  ocrResultPath?: string | null;
  githubReviewId?: string | null;
  headSha?: string | null;
  prNumber?: number | null;
  purpose?: 'standard' | 'verification';
  sourceReviewAgentId?: string;
  autofixIneligible?: boolean;
}

export interface AgentPullRequest {
  number: number;
  url: string;
  state: 'open' | 'closed' | 'merged';
  title: string;
  createdAt: string;
  mergedAt: string | null;
  updatedAt: string;
}

export type GitFileChangeKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'unknown';

export interface GitChangedFile {
  path: string;
  kind: GitFileChangeKind;
  statusCode: string;
}

export interface AgentGitStatus {
  filesChanged: number;
  files: GitChangedFile[];
  updatedAt: string;
}

export interface AgentTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
  /** True when any part of `cost` was computed from configured token rates rather than reported by the provider. */
  costEstimated?: boolean;
}

export interface OverallTokenUsage extends AgentTokenUsage {}

export interface ModelTokenCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export type ModelTokenCosts = Record<string, ModelTokenCost>;

export type BootstrapStatus = 'skipped' | 'running' | 'completed' | 'failed';

export type AgentBootstrapSource = 'script' | 'explicit' | 'profile' | 'detect' | 'none';

/** Host-run workspace bootstrap state; mirrors the server-side record. */
export interface AgentBootstrapState {
  status: BootstrapStatus;
  /** Setup command resolved and run (or pending when `status === 'running'`) */
  command?: string;
  /** Profile name(s) resolved to the command */
  profiles?: string[];
  /** How the command was resolved */
  source?: AgentBootstrapSource;
  durationMs?: number;
  exitCode?: number;
  /** Last lines of command output */
  outputTail?: string;
  error?: string;
}

/** Host-run post-run check names. */
export type CheckName = 'build' | 'lint' | 'test' | 'verify';

/** One host-run check, as recorded by the server. */
export interface AgentCheckRun {
  name: CheckName;
  command: string;
  exitCode: number;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  outputTail: string;
}

/** One verification pass: `attempt` 0 is after the task turn, 1..n after repair n. */
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
  /** Filled by 1.5 */
  assistantText?: string;
}

/** Host-run verification state; mirrors the server-side record. */
export interface AgentVerification {
  state: 'unverified' | 'passed' | 'failed' | 'machine_failure';
  configSource: 'base' | 'none';
  maxRepairAttempts: number;
  /** True when the repo allows a draft PR for a failing run */
  draftPrOnFailure?: boolean;
  attempts: AgentVerificationAttempt[];
}

export interface AgentsListResponse {
  agents: Agent[];
  overallTokenUsage: OverallTokenUsage;
}

export interface Agent {
  agentId: string;
  repoId: string;
  status: AgentStatus | string;
  /** Repair turn in progress (1-based), from the host verification loop */
  repairAttempt?: number;
  mode?: AgentMode | LegacyAgentMode;
  workspaceId?: string;
  prompt?: string;
  agentBranch?: string;
  branch?: string;
  baseBranch?: string;
  useExistingBranch?: boolean;
  model?: string | null;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
  commitSha?: string;
  filesChanged?: number;
  pushed?: boolean;
  error?: string;
  turnCount?: number;
  lastActivityAt?: string | null;
  awaitingInputSince?: string | null;
  messagesPreview?: string | null;
  gitStatus?: AgentGitStatus | null;
  autoApprovePermissions?: boolean;
  result?: { warning?: string; commitSha?: string | null; opencodeSuccess?: boolean };
  pullRequest?: AgentPullRequest | null;
  parentAgentId?: string | null;
  review?: AgentReviewMetadata | null;
  tokenUsage?: AgentTokenUsage;
  allowSuccessors?: boolean;
  /** Host-run workspace bootstrap (setup command) before the agent starts */
  bootstrap?: AgentBootstrapState;
  /** Host-run checks after the model's turn */
  verification?: AgentVerification | null;
  queue?: AgentQueueState;
}

export const GENERAL_CONFIG_FIELDS = ['webhookUrl'] as const;

export const MODELS_CONFIG_FIELDS = [
  'ollamaBaseUrl',
  'ollamaCloudApiKey',
  'ollamaCloudBaseUrl',
  'openaiCompatibleBaseUrl',
  'openaiCompatibleApiKey',
] as const;

export const GITHUB_CONFIG_FIELDS = [
  'githubAppId',
  'githubAppInstallationId',
  'githubAppPrivateKey',
  'gitUserName',
  'gitUserEmail',
] as const;

export const OPENCODE_CONFIG_FIELDS = [
  'opencodeProvider',
  'opencodeModel',
  'systemPrompt',
] as const;

export const OCR_CONFIG_FIELDS = ['reviewProvider', 'reviewModel'] as const;

export const CONFIG_FIELDS = [
  ...MODELS_CONFIG_FIELDS,
  ...OPENCODE_CONFIG_FIELDS,
  ...OCR_CONFIG_FIELDS,
  ...GITHUB_CONFIG_FIELDS,
  ...GENERAL_CONFIG_FIELDS,
] as const;

export type ConfigField = (typeof CONFIG_FIELDS)[number];

export const BATCH_ACTIVE_AGENT_STATUSES = new Set<AgentStatus>([
  'queued',
  'running',
  'processing',
  'verifying',
  'repairing',
  'completing',
]);

// `awaiting_input` is legacy only, so it is not an active status.
export const ACTIVE_AGENT_STATUSES = new Set<AgentStatus>([...BATCH_ACTIVE_AGENT_STATUSES]);

export const TERMINAL_AGENT_STATUSES = new Set<AgentStatus>([
  'completed',
  'failed',
  'needs_attention',
  'failed_machine',
  'cancelled',
]);

export function getAgentMode(agent: Agent): AgentMode | LegacyAgentMode {
  return agent.mode || 'batch';
}

/** Modes removed in v1 — such records are shown but not actionable. */
export function isLegacyAgentMode(agent: Agent): boolean {
  const mode = getAgentMode(agent);
  return mode === 'interactive' || mode === 'loop';
}

export function isReviewAgent(agent: Agent): boolean {
  return getAgentMode(agent) === 'review';
}

export interface QueueOnBranchPrefill {
  repoId: string;
  baseBranch: string;
  agentBranch: string;
}

export function queueOnBranchPrefill(agent: Agent): QueueOnBranchPrefill | null {
  if (isReviewAgent(agent)) return null;
  const agentBranch = agent.agentBranch || agent.branch;
  if (!agentBranch) return null;
  return {
    repoId: agent.repoId,
    baseBranch: agent.baseBranch || 'main',
    agentBranch,
  };
}

function isDuplicateBranchReview(
  existingAgent: Agent,
  parentAgentId: string,
  baseBranch: string,
  headBranch: string,
): boolean {
  if (existingAgent.mode !== 'review' || existingAgent.parentAgentId !== parentAgentId) {
    return false;
  }
  if (!ACTIVE_AGENT_STATUSES.has(existingAgent.status as AgentStatus)) {
    return false;
  }
  const review = existingAgent.review;
  if (!review) {
    return false;
  }
  return review.baseBranch === baseBranch && review.headBranch === headBranch;
}

function isBranchInUse(
  agents: Agent[],
  repoId: string,
  branch: string,
  excludeAgentId?: string,
): boolean {
  return agents.some(
    (entry) =>
      entry.agentId !== excludeAgentId &&
      entry.repoId === repoId &&
      ACTIVE_AGENT_STATUSES.has(entry.status as AgentStatus) &&
      entry.agentBranch === branch,
  );
}

export function canReviewBranches(
  agent: Agent,
  options: { relatedAgents?: Agent[]; baseBranch?: string; agentsLoaded?: boolean },
): boolean {
  if (
    isReviewAgent(agent) ||
    agent.status !== 'completed' ||
    agent.pushed !== true ||
    !(agent.agentBranch || agent.branch)
  ) {
    return false;
  }

  // Wait until the caller has fetched agents; unlike Create PR this needs conflict checks.
  if (!options.agentsLoaded) {
    return false;
  }

  const headBranch = agent.agentBranch || agent.branch!;
  const relatedAgents = options.relatedAgents ?? [];

  if (
    options.baseBranch &&
    relatedAgents.some((entry) =>
      isDuplicateBranchReview(entry, agent.agentId, options.baseBranch!, headBranch),
    )
  ) {
    return false;
  }

  if (isBranchInUse(relatedAgents, agent.repoId, headBranch, agent.agentId)) {
    return false;
  }

  return true;
}

export function agentModeBadgeVariant(
  mode: AgentMode | LegacyAgentMode,
): 'processing' | 'neutral' {
  if (mode === 'review') return 'processing';
  return 'neutral';
}

export function isAgentActive(agent: Agent): boolean {
  return ACTIVE_AGENT_STATUSES.has(agent.status as AgentStatus);
}

export function canCreatePullRequest(agent: Agent): boolean {
  if (agent.pushed !== true || agent.pullRequest) return false;
  if (agent.status === 'completed') return agent.result?.opencodeSuccess === true;
  // Failed checks only get a draft PR when the repo asked for one.
  return agent.status === 'needs_attention' && agent.verification?.draftPrOnFailure === true;
}

export function buildGitHubPullRequestUrl(
  repo: Pick<Repo, 'owner' | 'name'>,
  prNumber: number,
): string {
  return `https://github.com/${repo.owner}/${repo.name}/pull/${prNumber}`;
}

export function getAgentWorkingBranch(agent: Agent): string | null {
  if (agent.review?.headBranch) {
    return agent.review.headBranch;
  }
  return agent.agentBranch || agent.branch || null;
}

export function isChainedAgentSession(agent: Agent): boolean {
  return Boolean(agent.parentAgentId || agent.queue?.predecessorId);
}

export function findOpenBranchPullRequest(
  agent: Agent,
  agents: Agent[],
): AgentPullRequest | null {
  const branch = getAgentWorkingBranch(agent);
  if (!branch) {
    return null;
  }

  const visited = new Set<string>();
  const openPullRequest = (entry: Agent | undefined): AgentPullRequest | null => {
    if (!entry?.pullRequest || entry.pullRequest.state !== 'open') {
      return null;
    }
    return entry.pullRequest;
  };

  let currentId: string | null = agent.queue?.predecessorId ?? agent.parentAgentId ?? null;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const entry = agents.find((candidate) => candidate.agentId === currentId);
    const pullRequest = openPullRequest(entry);
    if (pullRequest) {
      return pullRequest;
    }
    if (!entry) {
      break;
    }
    currentId = entry.queue?.predecessorId ?? entry.parentAgentId ?? null;
  }

  for (const entry of agents) {
    if (
      entry.agentId === agent.agentId ||
      visited.has(entry.agentId) ||
      entry.repoId !== agent.repoId ||
      getAgentWorkingBranch(entry) !== branch
    ) {
      continue;
    }
    const pullRequest = openPullRequest(entry);
    if (pullRequest) {
      return pullRequest;
    }
  }

  return null;
}

export function getLinkedPullRequest(
  agent: Agent,
  repo: Repo | null | undefined,
  agents: Agent[] = [],
): AgentPullRequest | null {
  if (agent.pullRequest) {
    return agent.pullRequest;
  }

  if (agent.review?.prNumber && repo) {
    return {
      number: agent.review.prNumber,
      url: buildGitHubPullRequestUrl(repo, agent.review.prNumber),
      state: 'open',
      title: `PR #${agent.review.prNumber}`,
      createdAt: agent.createdAt || '',
      mergedAt: null,
      updatedAt: agent.finishedAt || agent.createdAt || '',
    };
  }

  if (isChainedAgentSession(agent) || isReviewAgent(agent)) {
    return findOpenBranchPullRequest(agent, agents);
  }

  return null;
}

export function getLinkedPullRequestUrl(
  agent: Agent,
  repo: Repo | null | undefined,
  agents: Agent[] = [],
): string | null {
  const linked = getLinkedPullRequest(agent, repo, agents);
  return linked?.url ?? null;
}

export function getReviewPullRequestUrl(
  agent: Agent,
  repo: Repo | null | undefined,
  relatedAgents: Agent[] = [],
): string | null {
  return getLinkedPullRequestUrl(agent, repo, relatedAgents);
}

export const DEFAULT_API_TOKEN = 'localagent-box';
