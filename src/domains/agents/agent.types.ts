import { buildLoopState, LOOP_ACTIVE_STATUSES } from '../../lib/loop-state';
import type { Agent, AgentMode, AgentStatus } from '../../types';

export { LOOP_ACTIVE_STATUSES };

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

export function withLoopFields(agent: Agent): Agent {
  if (getAgentMode(agent) !== 'loop') {
    return agent;
  }
  const loopOverrides =
    agent.loopMaxIterations !== undefined ? { maxIterations: agent.loopMaxIterations } : {};
  return {
    ...agent,
    mode: 'loop',
    loop: buildLoopState(agent.status, { ...agent.loop, ...loopOverrides }, agent),
  };
}

export function withDerivedAgentFields(agent: Agent): Agent {
  return withLoopFields({ ...agent, gitStatus: agent.gitStatus ?? undefined });
}
