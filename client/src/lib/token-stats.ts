import type { Agent, AgentTokenUsage } from '../api/types';

export interface RepoTokenStats {
  repoId: string;
  sessionCount: number;
  sessionsWithUsage: number;
  usage: AgentTokenUsage;
}

export interface GlobalTokenStats {
  overall: AgentTokenUsage;
  sessionCount: number;
  sessionsWithUsage: number;
  averageTokensPerSession: number;
  byRepo: RepoTokenStats[];
}

const EMPTY_USAGE: AgentTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
};

export function agentTokenTotal(usage: AgentTokenUsage): number {
  return usage.inputTokens + usage.outputTokens;
}

function addUsage(acc: AgentTokenUsage, usage: AgentTokenUsage): AgentTokenUsage {
  return {
    inputTokens: acc.inputTokens + usage.inputTokens,
    outputTokens: acc.outputTokens + usage.outputTokens,
    cacheReadTokens: (acc.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0),
    cacheWriteTokens: (acc.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
    cost: (acc.cost ?? 0) + (usage.cost ?? 0),
  };
}

export function computeGlobalTokenStats(agents: Agent[]): GlobalTokenStats {
  let overall = { ...EMPTY_USAGE };
  let sessionsWithUsage = 0;
  const byRepoMap = new Map<string, RepoTokenStats>();

  for (const agent of agents) {
    const repoId = agent.repoId || 'unknown';
    let repoStats = byRepoMap.get(repoId);
    if (!repoStats) {
      repoStats = {
        repoId,
        sessionCount: 0,
        sessionsWithUsage: 0,
        usage: { ...EMPTY_USAGE },
      };
      byRepoMap.set(repoId, repoStats);
    }

    repoStats.sessionCount += 1;

    if (agent.tokenUsage) {
      sessionsWithUsage += 1;
      repoStats.sessionsWithUsage += 1;
      overall = addUsage(overall, agent.tokenUsage);
      repoStats.usage = addUsage(repoStats.usage, agent.tokenUsage);
    }
  }

  const totalTokens = agentTokenTotal(overall);
  const averageTokensPerSession =
    sessionsWithUsage > 0 ? totalTokens / sessionsWithUsage : 0;

  const byRepo = [...byRepoMap.values()]
    .filter((entry) => agentTokenTotal(entry.usage) > 0)
    .sort((a, b) => agentTokenTotal(b.usage) - agentTokenTotal(a.usage));

  return {
    overall,
    sessionCount: agents.length,
    sessionsWithUsage,
    averageTokensPerSession,
    byRepo,
  };
}
