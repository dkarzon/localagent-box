import type { AgentNoChangeExplanation, NoChangeReason } from '../../types';

/** Directory the host reads agent-written artefacts from (see item 2.5). Forward slashes, as git paths use them. */
export const ARTEFACTS_DIR = '.localagent-box/artefacts';

/** Artefact written by the model for the v1 1.3 zero-change completion gate. */
export const NO_CHANGE_ARTEFACT_PATH = `${ARTEFACTS_DIR}/no-change.json`;

export const NO_CHANGE_EXPLANATION_MIN_CHARS = 20;
export const NO_CHANGE_EXPLANATION_MAX_CHARS = 2000;
export const NO_CHANGE_MAX_EVIDENCE_ITEMS = 10;

const REASONS = ['already_done', 'not_applicable', 'blocked', 'unclear_task'] as const;

/**
 * JSON Schema for `NoChangeExplanation`, written out for the prompt.
 * TODO(3.1): move this to the shared `ARTEFACT_SCHEMAS` registry and use
 * `parseArtefact('no-change', …)` and `schemaPromptBlock('no-change')`; the validator
 * below is the same rules written by hand until 3.1 lands.
 */
export const NO_CHANGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reason', 'explanation', 'evidence'],
  properties: {
    reason: { type: 'string', enum: [...REASONS] },
    explanation: {
      type: 'string',
      minLength: NO_CHANGE_EXPLANATION_MIN_CHARS,
      maxLength: NO_CHANGE_EXPLANATION_MAX_CHARS,
    },
    evidence: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      maxItems: NO_CHANGE_MAX_EVIDENCE_ITEMS,
    },
  },
};

export function noChangeSchemaBlock(): string {
  return ['```json', JSON.stringify(NO_CHANGE_SCHEMA, null, 2), '```'].join('\n');
}

export type ArtefactParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** Outermost `{…}` of a reply, with a leading ```json fence removed. */
function extractJsonObject(text: string): string | null {
  const body = text
    .replace(/^\s*```json\s*/i, '')
    .replace(/```\s*$/, '');
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return null;
  }
  return body.slice(start, end + 1);
}

export function validateNoChangeExplanation(raw: unknown): string[] {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return ['<root>: must be a JSON object'];
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.reason !== 'string') {
    errors.push('reason: must be a string');
  } else if (!REASONS.includes(obj.reason as NoChangeReason)) {
    errors.push(`reason: must be one of ${REASONS.join(', ')}`);
  }

  if (typeof obj.explanation !== 'string') {
    errors.push('explanation: must be a string');
  } else if (
    obj.explanation.length < NO_CHANGE_EXPLANATION_MIN_CHARS ||
    obj.explanation.length > NO_CHANGE_EXPLANATION_MAX_CHARS
  ) {
    errors.push(
      `explanation: must be between ${NO_CHANGE_EXPLANATION_MIN_CHARS} and ${NO_CHANGE_EXPLANATION_MAX_CHARS} characters`,
    );
  }

  if (!Array.isArray(obj.evidence)) {
    errors.push('evidence: must be an array of strings');
  } else if (obj.evidence.length > NO_CHANGE_MAX_EVIDENCE_ITEMS) {
    errors.push(`evidence: must have at most ${NO_CHANGE_MAX_EVIDENCE_ITEMS} items`);
  } else {
    obj.evidence.forEach((entry, index) => {
      if (typeof entry !== 'string' || entry.trim() === '') {
        errors.push(`evidence[${index}]: must be a non-empty string`);
      }
    });
  }

  return errors;
}

/** Reads artefact text (or a model reply) into a validated explanation. */
export function parseNoChangeExplanation(text: string): ArtefactParseResult<AgentNoChangeExplanation> {
  const jsonText = extractJsonObject(text);
  if (jsonText === null) {
    return { ok: false, errors: ['<root>: no JSON object found'] };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(jsonText) as unknown;
  } catch (err) {
    return { ok: false, errors: [`<root>: invalid JSON (${err instanceof Error ? err.message : String(err)})`] };
  }

  const errors = validateNoChangeExplanation(raw);
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const obj = raw as Record<string, unknown>;
  return {
    ok: true,
    value: {
      reason: obj.reason as NoChangeReason,
      explanation: obj.explanation as string,
      evidence: (obj.evidence as string[]).map((entry) => entry.trim()),
    },
  };
}
