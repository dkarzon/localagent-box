import type { Agent, AgentMode, AgentStatus, LegacyAgentMode } from '../../types';

export const TERMINAL_STATUSES = new Set<AgentStatus>([
  'completed',
  'failed',
  /** Repair attempts used up: pushed, waiting for a person (v1 1.2) */
  'needs_attention',
  'failed_machine',
  'cancelled',
]);
export const BATCH_ACTIVE_STATUSES = new Set<AgentStatus>([
  'queued',
  'running',
  'processing',
  'verifying',
  'repairing',
  'completing',
]);
// `awaiting_input` is legacy only: pre-v1 interactive records may still hold it, but no
// current run can set it, so it is not an active status.
export const ACTIVE_STATUSES = new Set<AgentStatus>([...BATCH_ACTIVE_STATUSES]);

export function getAgentMode(agent: Pick<Agent, 'mode'>): AgentMode | LegacyAgentMode {
  return agent.mode || 'batch';
}

/** Records created under a mode removed in v1; they are displayed but never run again. */
export function isLegacyMode(agent: Pick<Agent, 'mode'>): boolean {
  const mode = getAgentMode(agent);
  return mode === 'interactive' || mode === 'loop';
}

export function withDerivedAgentFields(agent: Agent): Agent {
  return { ...agent, gitStatus: agent.gitStatus ?? undefined };
}
