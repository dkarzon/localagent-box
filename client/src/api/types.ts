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

export interface LoopStepConfig {
  verb: LoopVerb;
  prompt: string;
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
  autoReviewPullRequests?: boolean;
  reviewModel?: string;
  ollama?: OllamaStatus;
  opencode?: { path?: string };
}

export interface GithubStatus {
  configured?: boolean;
  gitUserConfigured?: boolean;
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
  createdAt?: string;
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
}

export const CONFIG_FIELDS = [
  'ollamaBaseUrl',
  'opencodeModel',
  'opencodeProvider',
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

function isDuplicateBranchReview(
  existingAgent: Agent,
  parentAgentId: string,
  baseBranch: string,
  headBranch: string,
): boolean {
  if (existingAgent.mode !== 'review' || existingAgent.parentAgentId !== parentAgentId) {
    return false;
  }
  if (existingAgent.status === 'failed' || existingAgent.status === 'cancelled') {
    return false;
  }
  const review = existingAgent.review;
  if (!review) {
    return false;
  }
  return review.baseBranch === baseBranch && review.headBranch === headBranch;
}

export function canReviewBranches(
  agent: Agent,
  options?: { relatedAgents?: Agent[]; baseBranch?: string },
): boolean {
  if (
    isReviewAgent(agent) ||
    agent.status !== 'completed' ||
    agent.pushed !== true ||
    !(agent.agentBranch || agent.branch)
  ) {
    return false;
  }

  const headBranch = agent.agentBranch || agent.branch;
  if (
    headBranch &&
    options?.relatedAgents &&
    options.baseBranch &&
    options.relatedAgents.some((entry) =>
      isDuplicateBranchReview(entry, agent.agentId, options.baseBranch!, headBranch),
    )
  ) {
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

export const DEFAULT_API_TOKEN = 'localagent-box';
