import { CodedError, type LoopVerb, type LoopVerbModels } from '../types';

export const LOOP_VERBS: LoopVerb[] = ['INITIAL_PLAN', 'ORIENT', 'ACT', 'REFLECT'];

/**
 * Verbs from before OBSERVE + PLAN were merged into ORIENT. Folded into ORIENT so
 * persisted config.json, API payloads, and repo loop.json written against the old
 * names keep working instead of hard-failing.
 */
const LEGACY_VERB_ALIASES: Record<string, LoopVerb> = {
  OBSERVE: 'ORIENT',
  PLAN: 'ORIENT',
};

export function canonicalizeLoopVerb(rawKey: string): LoopVerb | null {
  const mapped = LEGACY_VERB_ALIASES[rawKey] ?? (rawKey as LoopVerb);
  return LOOP_VERBS.includes(mapped) ? mapped : null;
}

/** Fold an entry into the accumulator, never letting an empty value clobber a non-empty one. */
function assignVerbModel(target: LoopVerbModels, verb: LoopVerb, model: string): void {
  if (model === '' && target[verb] && target[verb] !== '') {
    return;
  }
  target[verb] = model;
}

export function sanitizeLoopVerbModels(value: unknown): LoopVerbModels {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CodedError('loopVerbModels must be an object', 'VALIDATION_ERROR');
  }

  const result: LoopVerbModels = {};
  for (const [rawKey, val] of Object.entries(value)) {
    const verb = canonicalizeLoopVerb(rawKey);
    if (!verb) {
      throw new CodedError(`Unknown loop verb model key: ${rawKey}`, 'VALIDATION_ERROR');
    }
    if (val !== '' && typeof val !== 'string') {
      throw new CodedError(`loopVerbModels.${rawKey} must be a string`, 'VALIDATION_ERROR');
    }
    assignVerbModel(result, verb, val === '' ? '' : String(val));
  }
  return result;
}

/** Non-throwing migration for values loaded from disk: fold legacy verbs, drop unknown keys. */
export function normalizeLoopVerbModels(value: unknown): LoopVerbModels {
  const result: LoopVerbModels = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return result;
  }
  for (const [rawKey, val] of Object.entries(value)) {
    const verb = canonicalizeLoopVerb(rawKey);
    if (!verb) {
      continue;
    }
    assignVerbModel(result, verb, typeof val === 'string' ? val : '');
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
