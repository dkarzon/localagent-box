import { normalizeLoopVerbModels } from '../../../lib/loop-verb-models';
import type { AgentJob, AppConfig, LoopVerb } from '../../../types';

function verbModel(models: unknown, verb: LoopVerb): string | undefined {
  const model = normalizeLoopVerbModels(models)[verb];
  return model && model !== '' ? model : undefined;
}

/** Model resolution: run override → Settings verb → job fallback → global default */
export function resolveLoopStepModel(
  verb: LoopVerb,
  config: AppConfig,
  job?: AgentJob,
): string | null {
  const runOverride = verbModel(job?.loopVerbModels, verb);
  if (runOverride) {
    return runOverride;
  }
  const verbSpecific = verbModel(config.loopVerbModels, verb);
  if (verbSpecific) {
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

  for (const model of Object.values(normalizeLoopVerbModels(config.loopVerbModels))) {
    if (model && model !== '') {
      set.add(model);
    }
  }

  for (const model of Object.values(normalizeLoopVerbModels(job?.loopVerbModels))) {
    if (model && model !== '') {
      set.add(model);
    }
  }

  if (job?.model) {
    set.add(job.model);
  }

  return Array.from(set);
}
