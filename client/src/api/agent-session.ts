import { apiFetch, authHeaders } from './client';
import type { Agent, AgentFindingsResponse, AgentGitStatus } from './types';
import type { AgentEvent, AgentMessage } from './agent-events';

export async function fetchAgentGitStatus(
  agentId: string,
): Promise<AgentGitStatus & { updatedAt: string | null }> {
  return apiFetch(`/api/v1/agents/${encodeURIComponent(agentId)}/git-status`);
}

export interface AgentReviewResultResponse {
  agentId: string;
  markdown: string;
  result: Record<string, unknown>;
  sessionId?: string | null;
  sessionMarkdown?: string | null;
  session?: Record<string, unknown> | null;
}

export async function fetchAgentReviewResult(
  agentId: string,
): Promise<AgentReviewResultResponse | null> {
  const response = await fetch(`/api/v1/agents/${encodeURIComponent(agentId)}/review-result`);
  if (response.status === 404) {
    return null;
  }
  const text = await response.text();
  const body = text
    ? (JSON.parse(text) as AgentReviewResultResponse & { error?: string })
    : ({} as AgentReviewResultResponse & { error?: string });
  if (!response.ok) {
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return body;
}

export async function fetchAgentFindings(
  agentId: string,
): Promise<AgentFindingsResponse | null> {
  const response = await fetch(`/api/v1/agents/${encodeURIComponent(agentId)}/findings`);
  if (response.status === 404) {
    return null;
  }
  const text = await response.text();
  const body = text
    ? (JSON.parse(text) as AgentFindingsResponse & { error?: string })
    : ({} as AgentFindingsResponse & { error?: string });
  if (!response.ok) {
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return body;
}

export async function resumeAutofixChain(
  agentId: string,
  token: string,
): Promise<{ agentId: string; batchIndex: number }> {
  return apiFetch<{ agentId: string; batchIndex: number }>(
    `/api/v1/agents/${encodeURIComponent(agentId)}/autofix/resume`,
    {
      method: 'POST',
      headers: authHeaders(token),
    },
  );
}

export async function fetchAgentMessages(
  agentId: string,
  since = 0,
): Promise<{ messages: AgentMessage[]; lastEventSeq: number; events: AgentEvent[] }> {
  const params = new URLSearchParams();
  if (since > 0) {
    params.set('since', String(since));
  }
  const query = params.toString();
  const data = await apiFetch<{
    messages?: AgentMessage[];
    lastEventSeq?: number;
    events?: AgentEvent[];
  }>(`/api/v1/agents/${encodeURIComponent(agentId)}/messages${query ? `?${query}` : ''}`);
  return {
    messages: data.messages || [],
    lastEventSeq: data.lastEventSeq ?? 0,
    events: data.events || [],
  };
}

export async function sendAgentMessage(
  agentId: string,
  text: string,
  token: string,
): Promise<Agent> {
  const data = await apiFetch<{ agent: Agent }>(
    `/api/v1/agents/${encodeURIComponent(agentId)}/messages`,
    {
      method: 'POST',
      headers: authHeaders(token, true),
      body: JSON.stringify({ text }),
    },
  );
  return data.agent;
}

export async function finishAgent(agentId: string, token: string): Promise<Agent> {
  const data = await apiFetch<{ agent: Agent }>(
    `/api/v1/agents/${encodeURIComponent(agentId)}/finish`,
    {
      method: 'POST',
      headers: authHeaders(token),
    },
  );
  return data.agent;
}

export async function commitOutstandingChanges(agentId: string, token: string): Promise<Agent> {
  const data = await apiFetch<{ agent: Agent }>(
    `/api/v1/agents/${encodeURIComponent(agentId)}/commit-outstanding`,
    {
      method: 'POST',
      headers: authHeaders(token),
    },
  );
  return data.agent;
}

export function buildEventsUrl(agentId: string, since = 0): string {
  const params = new URLSearchParams();
  if (since > 0) {
    params.set('since', String(since));
  }
  const query = params.toString();
  return `/api/v1/agents/${encodeURIComponent(agentId)}/events${query ? `?${query}` : ''}`;
}
