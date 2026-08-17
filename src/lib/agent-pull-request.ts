import type { Agent, AgentPullRequest } from '../types';

export interface GitHubPullRequestResponse {
  number: number;
  html_url: string;
  state: string;
  title: string;
  created_at: string;
  merged_at: string | null;
  updated_at: string;
  head?: { sha?: string; ref?: string };
}

export function mapGitHubPullRequest(pr: GitHubPullRequestResponse): AgentPullRequest {
  const state: AgentPullRequest['state'] =
    pr.merged_at != null ? 'merged' : pr.state === 'open' ? 'open' : 'closed';

  return {
    number: pr.number,
    url: pr.html_url,
    state,
    title: pr.title,
    createdAt: pr.created_at,
    mergedAt: pr.merged_at,
    updatedAt: pr.updated_at,
  };
}

export function canCreatePullRequest(agent: Agent): boolean {
  return (
    agent.status === 'completed' &&
    agent.result?.opencodeSuccess === true &&
    agent.pushed === true &&
    !agent.pullRequest
  );
}

export function buildDefaultPullRequestTitle(agent: Agent): string {
  if (agent.commitMessage?.trim()) {
    return agent.commitMessage.trim();
  }
  const branch = agent.agentBranch || agent.branch;
  if (branch) {
    return `Agent: ${branch}`;
  }
  return `Agent session ${agent.agentId}`;
}

export function buildPullRequestMetadataSection(agent: Agent, base?: string): string {
  const lines = ['Created from a Local Agent Box session.', ''];

  const branch = agent.agentBranch || agent.branch;
  if (branch) {
    lines.push(`**Branch:** \`${branch}\``);
  }
  const mergeBase = base ?? agent.baseBranch;
  if (mergeBase) {
    lines.push(`**Base:** \`${mergeBase}\``);
  }
  if (agent.commitSha) {
    lines.push(`**Commit:** \`${agent.commitSha.slice(0, 7)}\``);
  }
  lines.push(`**Session:** \`${agent.agentId}\``);
  const models = agent.modelsUsed && agent.modelsUsed.length > 0
    ? agent.modelsUsed.filter((m): m is string => !!m)
    : [];

  if (models.length > 0) {
    const formatted = models.map((m) => `\`${m}\``).join(', ');
    lines.push(`**Models:** ${formatted}`);
  } else if (agent.model) {
    lines.push(`**Model:** \`${agent.model}\``);
  }

  return lines.join('\n');
}

export function buildDefaultPullRequestBody(agent: Agent, base?: string): string {
  const lines = [buildPullRequestMetadataSection(agent, base)];

  if (agent.prompt?.trim()) {
    lines.unshift('## Prompt', '', agent.prompt.trim(), '');
  }

  return lines.join('\n');
}
