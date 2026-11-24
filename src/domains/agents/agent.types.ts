import type { Agent, AgentMode, AgentStatus } from '../../types';

export const TERMINAL_STATUSES = new Set<AgentStatus>(['completed', 'failed', 'cancelled']);
export const BATCH_ACTIVE_STATUSES = new Set<AgentStatus>(['queued', 'running', 'processing', 'completing']);
export const ACTIVE_STATUSES = new Set<AgentStatus>([
  ...BATCH_ACTIVE_STATUSES,
  'awaiting_input',
  'processing',
  'completing',
]);

export function getAgentMode(agent: Pick<Agent, 'mode'>): AgentMode {
  return agent.mode || 'batch';
}

export function withDerivedAgentFields(agent: Agent): Agent {
  return { ...agent, gitStatus: agent.gitStatus ?? undefined };
}
