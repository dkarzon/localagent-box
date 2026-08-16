import { apiFetch, authHeaders } from './client';
import type { Agent, AgentPullRequest } from './types';

export interface CleanupOldWorkspacesResult {
  daysToKeep: number;
  deleted: string[];
  skippedActive: string[];
  orphanWorkspacesRemoved: string[];
}

export async function cleanupOldWorkspaces(
  daysToKeep: number,
  token: string,
): Promise<CleanupOldWorkspacesResult> {
  return apiFetch<CleanupOldWorkspacesResult>('/api/v1/agents/cleanup', {
    method: 'POST',
    headers: authHeaders(token, true),
    body: JSON.stringify({ daysToKeep }),
  });
}

export async function deleteAgentSession(agentId: string, token: string): Promise<void> {
  await apiFetch(`/api/v1/agents/${encodeURIComponent(agentId)}/delete`, {
    method: 'POST',
    headers: authHeaders(token),
  });
}

export async function createAgentPullRequest(
  agentId: string,
  token: string,
  options: { title?: string; body?: string } = {},
): Promise<{ agent: Agent; pullRequest: AgentPullRequest }> {
  return apiFetch(`/api/v1/agents/${encodeURIComponent(agentId)}/pull-request`, {
    method: 'POST',
    headers: authHeaders(token, true),
    body: JSON.stringify(options),
  });
}

export async function refreshAgentPullRequest(
  agentId: string,
): Promise<{ agent: Agent; pullRequest: AgentPullRequest }> {
  return apiFetch(`/api/v1/agents/${encodeURIComponent(agentId)}/pull-request`);
}

export async function retryAgentSession(agentId: string, token: string): Promise<{ agent: Agent }> {
  return apiFetch(`/api/v1/agents/${encodeURIComponent(agentId)}/retry`, {
    method: 'POST',
    headers: authHeaders(token),
  });
}

export async function allowAgentSuccessors(
  agentId: string,
  token: string,
): Promise<{ agent: Agent; warning: string | null }> {
  return apiFetch(`/api/v1/agents/${encodeURIComponent(agentId)}/allow-successors`, {
    method: 'POST',
    headers: authHeaders(token),
  });
}
