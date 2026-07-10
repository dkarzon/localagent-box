import { CodedError, type LoopVerb, type LoopVerbModels } from '../types';

export const LOOP_VERBS: LoopVerb[] = ['INITIAL_PLAN', 'OBSERVE', 'PLAN', 'ACT', 'REFLECT'];

export function sanitizeLoopVerbModels(value: unknown): LoopVerbModels {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CodedError('loopVerbModels must be an object', 'VALIDATION_ERROR');
  }

  const result: LoopVerbModels = {};
  for (const [key, val] of Object.entries(value)) {
    if (!LOOP_VERBS.includes(key as LoopVerb)) {
      throw new CodedError(`Unknown loop verb model key: ${key}`, 'VALIDATION_ERROR');
    }
    if (val !== '' && typeof val !== 'string') {
      throw new CodedError(`loopVerbModels.${key} must be a string`, 'VALIDATION_ERROR');
    }
    result[key as LoopVerb] = val === '' ? '' : String(val);
  }
  return result;
}

/** Drop blank verb slots; return undefined when nothing remains. */
export function compactLoopVerbModels(models: LoopVerbModels): LoopVerbModels | undefined {
  const result: LoopVerbModels = {};
  for (const verb of LOOP_VERBS) {
    const model = models[verb];
    if (model && model.trim() !== '') {
      result[verb] = model.trim();
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
