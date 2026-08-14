import type { LoopOpenCodeAgent, LoopStepConfig, LoopVerb } from '../../../types';

const DEFAULT_LOOP_STEP_AGENTS: Record<LoopVerb, LoopOpenCodeAgent> = {
  INITIAL_PLAN: 'build',
  ORIENT: 'plan',
  ACT: 'build',
  REFLECT: 'plan',
};

export const LOOP_OPEN_CODE_AGENTS: readonly LoopOpenCodeAgent[] = ['build', 'plan'];

/**
 * Resolve the OpenCode agent profile for a loop step.
 * Read-only `plan` for ORIENT/REFLECT prevents accidental edits during reasoning;
 * `build` for INITIAL_PLAN and ACT retains write tools.
 */
export function resolveLoopStepOpenCodeAgent(
  verb: LoopVerb,
  stepAgent?: LoopOpenCodeAgent,
): LoopOpenCodeAgent {
  if (stepAgent) {
    return stepAgent;
  }
  return DEFAULT_LOOP_STEP_AGENTS[verb];
}

/** Effective agent for each configured iteration step (for startup logging). */
export function formatLoopStepAgentsSummary(steps: LoopStepConfig[]): string {
  const parts = [`INITIAL_PLAN=${resolveLoopStepOpenCodeAgent('INITIAL_PLAN')}`];
  for (const step of steps) {
    parts.push(`${step.verb}=${resolveLoopStepOpenCodeAgent(step.verb, step.agent)}`);
  }
  return parts.join(', ');
}
