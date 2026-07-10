import type { AgentInteractiveState, AgentStatus } from '../types';

export const INTERACTIVE_ACTIVE_STATUSES = new Set<AgentStatus>([
  'queued',
  'running',
  'awaiting_input',
  'processing',
  'completing',
]);

export function buildInteractiveState(status: AgentStatus): AgentInteractiveState {
  return {
    canSendMessage: status === 'awaiting_input',
    canFinish:
      INTERACTIVE_ACTIVE_STATUSES.has(status) &&
      status !== 'queued' &&
      status !== 'completing',
    pendingPermissionId: null,
  };
}
