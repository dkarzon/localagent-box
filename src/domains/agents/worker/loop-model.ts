import type { AgentJob, AppConfig, LoopVerb } from '../../../types';

/** Model resolution: run override → Settings verb → job fallback → global default */
export function resolveLoopStepModel(
  verb: LoopVerb,
  config: AppConfig,
  job?: AgentJob,
): string | null {
  const runOverride = job?.loopVerbModels?.[verb];
  if (runOverride && runOverride !== '') {
    return runOverride;
  }
  const verbSpecific = config.loopVerbModels?.[verb];
  if (verbSpecific && verbSpecific !== '') {
    return verbSpecific;
  }
  if (job?.model) {
    return job.model;
  }
  return config.opencodeModel || null;
}

/** Collect all distinct model IDs needed in the OpenCode config for a loop run */
export function collectLoopModels(config: AppConfig, job?: AgentJob): string[] {
  const set = new Set<string>();
  if (config.opencodeModel) {
    set.add(config.opencodeModel);
  }

  for (const verb of Object.keys(config.loopVerbModels || {}) as LoopVerb[]) {
    const model = config.loopVerbModels?.[verb];
    if (model && model !== '') {
      set.add(model);
    }
  }

  for (const verb of Object.keys(job?.loopVerbModels || {}) as LoopVerb[]) {
    const model = job?.loopVerbModels?.[verb];
    if (model && model !== '') {
      set.add(model);
    }
  }

  if (job?.model) {
    set.add(job.model);
  }

  return Array.from(set);
}
