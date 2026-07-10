import type { Agent, AgentLoopState, AgentStatus, LoopVerb } from '../types';

export const LOOP_ACTIVE_STATUSES = new Set<AgentStatus>([
  'queued',
  'running',
  'processing',
  'completing',
]);

export function canCommitLoopOutstanding(
  agent: Pick<Agent, 'status' | 'commitSha' | 'gitStatus'>,
): boolean {
  return (
    agent.status === 'failed' &&
    !agent.commitSha &&
    (agent.gitStatus?.filesChanged ?? 0) > 0
  );
}

export function buildLoopState(
  status: AgentStatus,
  existing?: Partial<AgentLoopState> | null,
  agent?: Pick<Agent, 'status' | 'commitSha' | 'gitStatus'> | null,
): AgentLoopState {
  return {
    iteration: existing?.iteration ?? 1,
    stepIndex: existing?.stepIndex ?? 0,
    currentVerb: existing?.currentVerb ?? ('OBSERVE' as LoopVerb),
    stepsInIteration: existing?.stepsInIteration ?? 0,
    maxIterations: existing?.maxIterations ?? 10,
    completionMarker: existing?.completionMarker ?? 'LOOP_COMPLETE',
    canFinish:
      LOOP_ACTIVE_STATUSES.has(status) && status !== 'queued' && status !== 'completing',
    canCommitOutstanding: agent ? canCommitLoopOutstanding(agent) : false,
    finishRequested: existing?.finishRequested ?? false,
    configSource: existing?.configSource ?? 'server-default',
    effectiveSteps: existing?.effectiveSteps ?? [],
  };
}
