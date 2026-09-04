export type StatusVariant = '' | 'success' | 'error';

export type AgentMode = 'batch' | 'interactive' | 'loop' | 'review';

export type LoopVerb = 'INITIAL_PLAN' | 'ORIENT' | 'ACT' | 'REFLECT';

/** Model id on the configured provider (e.g. Ollama tag). Empty string = use fallback. */
export type LoopVerbModels = Partial<Record<LoopVerb, string>>;

export const LOOP_VERB_MODELS_DEFAULT: LoopVerbModels = {
  INITIAL_PLAN: '',
  ORIENT: '',
  ACT: '',
  REFLECT: '',
};

export const LOOP_VERBS: LoopVerb[] = ['INITIAL_PLAN', 'ORIENT', 'ACT', 'REFLECT'];

export const LOOP_VERB_LABELS: Record<LoopVerb, { label: string; hint: string }> = {
  INITIAL_PLAN: { label: 'Initial plan', hint: 'One-time kickoff before iterations' },
  ORIENT: { label: 'Orient', hint: 'Read the code and pick the next change' },
  ACT: { label: 'Act', hint: 'Implementation (edits, commands)' },
  REFLECT: { label: 'Reflect', hint: 'Progress check / completion marker' },
};

export function mergeLoopVerbModels(from?: Partial<LoopVerbModels> | null): LoopVerbModels {
  return { ...LOOP_VERB_MODELS_DEFAULT, ...from };
}

export function hasNonEmptyLoopVerbModel(models?: LoopVerbModels | null): boolean {
  if (!models) return false;
  return LOOP_VERBS.some((verb) => Boolean(models[verb]?.trim()));
}

/** True when at least one loop step can resolve a model from run overrides, Settings, fallback, or global. */
export function hasResolvableLoopModel(options: {
  settingsVerbModels?: LoopVerbModels | null;
  runVerbModels?: LoopVerbModels | null;
  fallbackModel?: string | null;
  globalModel?: string | null;
}): boolean {
  const { settingsVerbModels, runVerbModels, fallbackModel, globalModel } = options;
  if (globalModel?.trim()) return true;
  if (fallbackModel?.trim()) return true;
  if (hasNonEmptyLoopVerbModel(settingsVerbModels)) return true;
  if (hasNonEmptyLoopVerbModel(runVerbModels)) return true;
  return false;
}

export type LoopOpenCodeAgent = 'build' | 'plan';

export interface LoopStepConfig {
  verb: LoopVerb;
  prompt: string;
  agent?: LoopOpenCodeAgent;
}

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
  canCommitOutstanding: boolean;
  finishRequested: boolean;
  configSource: 'server-default' | 'repo-override';
  effectiveSteps: LoopStepConfig[];
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
  predecessorStatus: AgentStatus | string | null;
  reason: string | null;
  canRetry: boolean;
  canAllowSuccessors: boolean;
}

export interface OllamaModel {
  name: string;
  size?: number;
  modifiedAt?: string;
}

export interface OllamaStatus {
  status?: string;
  reachable?: boolean;
  message?: string;
  url?: string;
  modelCount?: number;
  models?: OllamaModel[];
}

export interface AppConfig {
  ollamaBaseUrl?: string;
  opencodeModel?: string;
  opencodeProvider?: string;
  /** Default system prompt for agents, unless overridden per-repo or per-agent. Empty string is sent as `null` in GET. */
  systemPrompt?: string | null;
  githubAppId?: string;
  githubAppInstallationId?: string;
  hasGithubAppPrivateKey?: boolean;
  gitUserName?: string;
  gitUserEmail?: string;
  webhookUrl?: string;
  batchAutoApprovePermissions?: boolean;
  loopAutoApprovePermissions?: boolean;
  interactiveAutoApprovePermissions?: boolean;
  interactiveAgentTimeoutSeconds?: number;
  loopAgentTimeoutSeconds?: number;
  /** Per-verb model overrides for loop mode. Empty string = use fallback chain. */
  loopVerbModels?: LoopVerbModels;
  /** Bundled server default from config/loop.default.json */
  loopDefaultMaxIterations?: number;
  /** When true (default), auto-create a PR once an agent completes and pushes. Per-agent create request can override. */
  autoCreatePullRequest?: boolean;
  autoReviewPullRequests?: boolean;
  reviewModel?: string;
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
}

export interface AgentReviewMetadata {
  baseBranch?: string | null;
  headBranch?: string | null;
  background?: string | null;
  ocrResultPath?: string | null;
  githubReviewId?: string | null;
  headSha?: string | null;
  prNumber?: number | null;
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

export interface AgentInteractiveState {
  canSendMessage: boolean;
  canFinish: boolean;
  pendingPermissionId: string | null;
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
}

export interface OverallTokenUsage extends AgentTokenUsage {}

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

export interface AgentsListResponse {
  agents: Agent[];
  overallTokenUsage: OverallTokenUsage;
}

export interface Agent {
  agentId: string;
  repoId: string;
  status: AgentStatus | string;
  mode?: AgentMode;
  workspaceId?: string;
  prompt?: string;
  agentBranch?: string;
  branch?: string;
  baseBranch?: string;
  useExistingBranch?: boolean;
  model?: string | null;
  loopVerbModels?: LoopVerbModels;
  /** Per-session iteration cap for loop mode; omitted = global/repo default */
  loopMaxIterations?: number;
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
  interactive?: AgentInteractiveState;
  loop?: AgentLoopState;
  autoApprovePermissions?: boolean;
  result?: { warning?: string; commitSha?: string | null; opencodeSuccess?: boolean };
  pullRequest?: AgentPullRequest | null;
  parentAgentId?: string | null;
  review?: AgentReviewMetadata | null;
  tokenUsage?: AgentTokenUsage;
  allowSuccessors?: boolean;
  /** Host-run workspace bootstrap (setup command) before the agent starts */
  bootstrap?: AgentBootstrapState;
  queue?: AgentQueueState;
}

export const CONFIG_FIELDS = [
  'ollamaBaseUrl',
  'opencodeModel',
  'opencodeProvider',
  'systemPrompt',
  'githubAppId',
  'githubAppInstallationId',
  'githubAppPrivateKey',
  'gitUserName',
  'gitUserEmail',
  'webhookUrl',
] as const;

export type ConfigField = (typeof CONFIG_FIELDS)[number];

export const BATCH_ACTIVE_AGENT_STATUSES = new Set<AgentStatus>([
  'queued',
  'running',
  'processing',
  'completing',
]);

export const INTERACTIVE_ACTIVE_AGENT_STATUSES = new Set<AgentStatus>([
  'queued',
  'running',
  'awaiting_input',
  'processing',
  'completing',
]);

export const LOOP_ACTIVE_AGENT_STATUSES = new Set<AgentStatus>([
  'queued',
  'running',
  'processing',
  'completing',
]);

export const ACTIVE_AGENT_STATUSES = new Set<AgentStatus>([
  ...BATCH_ACTIVE_AGENT_STATUSES,
  'awaiting_input',
  'processing',
  'completing',
]);

export const TERMINAL_AGENT_STATUSES = new Set<AgentStatus>(['completed', 'failed', 'cancelled']);

export function getAgentMode(agent: Agent): AgentMode {
  return agent.mode || 'batch';
}

export function isInteractiveAgent(agent: Agent): boolean {
  return getAgentMode(agent) === 'interactive';
}

export function isLoopAgent(agent: Agent): boolean {
  return getAgentMode(agent) === 'loop';
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

export function formatLoopProgress(loop: AgentLoopState, stepModel?: string | null): string {
  if (loop.currentVerb === 'INITIAL_PLAN') {
    return stepModel?.trim() ? `Initial plan · ${stepModel.trim()}` : 'Initial plan';
  }

  const verbLabel = loop.currentVerb.toLowerCase();
  const verbPart = stepModel?.trim() ? `${verbLabel} · ${stepModel.trim()}` : verbLabel;
  const base = `Iteration ${loop.iteration}/${loop.maxIterations} · ${verbPart}`;
  if (loop.stepsInIteration === 0) {
    return base;
  }
  const stepNumber = loop.stepIndex + 1;
  return `${base} · step ${stepNumber}/${loop.stepsInIteration}`;
}

export function agentModeBadgeVariant(mode: AgentMode): 'awaiting' | 'processing' | 'neutral' {
  if (mode === 'interactive') return 'awaiting';
  if (mode === 'loop') return 'processing';
  if (mode === 'review') return 'processing';
  return 'neutral';
}

export function isAgentActive(agent: Agent): boolean {
  return ACTIVE_AGENT_STATUSES.has(agent.status as AgentStatus);
}

export function canCreatePullRequest(agent: Agent): boolean {
  return (
    agent.status === 'completed' &&
    agent.result?.opencodeSuccess === true &&
    agent.pushed === true &&
    !agent.pullRequest
  );
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
