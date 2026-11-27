import { CodedError, type AgentNoChangeExplanation } from '../../../types';
import { readFileWithin } from '../../../lib/safe-read';
import {
  NO_CHANGE_ARTEFACT_PATH,
  noChangeSchemaBlock,
  parseNoChangeExplanation,
} from '../../../lib/schemas/no-change';

export interface NoChangeArtefactOutcome {
  /** `missing` is a missing artefact; `invalid` is unreadable or off-schema. */
  status: 'valid' | 'invalid' | 'missing';
  explanation: AgentNoChangeExplanation | null;
  errors: string[];
}

/**
 * Read and validate the explanation the model wrote for a zero-change run. The
 * artefact is agent-controlled, so it goes through the safe reader (item 2.5), and
 * the host — not the model — decides whether it is valid.
 */
export function readNoChangeArtefact(
  workspaceDir: string,
  maxBytes?: number,
): NoChangeArtefactOutcome {
  let text: string | null;
  try {
    text = readFileWithin(workspaceDir, NO_CHANGE_ARTEFACT_PATH, { maxBytes });
  } catch (err) {
    const message = err instanceof CodedError ? err.message : String(err);
    return { status: 'invalid', explanation: null, errors: [message] };
  }

  if (text === null) {
    return {
      status: 'missing',
      explanation: null,
      errors: [`no artefact at ${NO_CHANGE_ARTEFACT_PATH}`],
    };
  }

  const parsed = parseNoChangeExplanation(text);
  if (!parsed.ok) {
    return { status: 'invalid', explanation: null, errors: parsed.errors };
  }
  return { status: 'valid', explanation: parsed.value, errors: [] };
}

/**
 * Follow-up turn for a run that changed no files (v1 1.3). One follow-up per run:
 * either the model implements, or it explains itself through the artefact.
 */
export function buildNoChangeExplanationPrompt(
  options: { validateCommand?: string | null } = {},
): string {
  const lines = [
    'You finished without changing any files. Either complete the task now, or, if no',
    'change is needed, explain why. To explain, write JSON to',
    `${NO_CHANGE_ARTEFACT_PATH} matching:`,
    noChangeSchemaBlock(),
  ];

  // TODO(3.3): the artefact CLI supplies the self-validation command; until then the host is the validator.
  if (options.validateCommand) {
    lines.push(
      `Run \`${options.validateCommand} no-change ${NO_CHANGE_ARTEFACT_PATH}\` before finishing.`,
    );
  }

  return lines.join('\n');
}
