import type { AgentMode } from '../../types';

export interface CreateAgentRequest {
  repoId: unknown;
  prompt: unknown;
  systemPrompt?: unknown;
  baseBranch?: unknown;
  agentBranch?: unknown;
  useExistingBranch?: unknown;
  commitMessage?: unknown;
  push?: unknown;
  pushOnFailure?: unknown;
  model?: unknown;
  loopVerbModels?: unknown;
  mode?: unknown;
  sessionId?: unknown;
  // Review-specific fields (mode: 'review')
  headBranch?: unknown;
  background?: unknown;
  parentAgentId?: unknown;
}

export interface CreateAgentResponse {
  agentId: string;
  workspaceId: string;
  repoId: string;
  mode: AgentMode;
  status: string;
  createdAt: string;
  baseBranch: string;
  agentBranch: string;
}

export interface SendMessageRequest {
  text: unknown;
}

export interface CreatePullRequestRequest {
  title?: unknown;
  body?: unknown;
}

export interface ListAgentsQuery {
  repoId?: string | null;
  status?: string | null;
}

export function toCreateAgentResponse(agent: {
  agentId: string;
  workspaceId: string;
  repoId: string;
  mode?: AgentMode;
  status: string;
  createdAt: string;
  baseBranch: string;
  agentBranch: string;
}): CreateAgentResponse {
  return {
    agentId: agent.agentId,
    workspaceId: agent.workspaceId,
    repoId: agent.repoId,
    mode: agent.mode || 'batch',
    status: agent.status,
    createdAt: agent.createdAt,
    baseBranch: agent.baseBranch,
    agentBranch: agent.agentBranch,
  };
}

export function parseCreatePullRequestOptions(body: Record<string, unknown>): {
  title?: string;
  body?: string;
} {
  return {
    title: typeof body.title === 'string' ? body.title : undefined,
    body: typeof body.body === 'string' ? body.body : undefined,
  };
}
