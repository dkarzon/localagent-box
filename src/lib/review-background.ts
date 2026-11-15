import type { Agent } from '../types';
import type { RepoPromptOverrides } from '../types';

/** Default review rules prepended to every OCR review background. */
export const DEFAULT_REVIEW_RULES = [
  'Review rules:',
  '- Only report problems introduced or made worse by this diff. Do not flag pre-existing patterns in unchanged code or shared helpers the diff only calls.',
  '- Report each distinct issue once, on the line where the fix belongs, even if it is visible from several files.',
  '- For a race-condition or concurrency claim, name the exact `await` or async boundary that opens the window. Synchronous JavaScript in Node runs to completion without interleaving; do not report races without an await between the check and the write.',
  '- Do not suggest refactors, helper extraction, or deduplication unless the duplication causes a concrete, reachable defect in this diff.',
  '- Every bug finding must describe a reachable failure: the input or state and the wrong result.',
].join('\n');

/**
 * Builds concatenated background context for OCR review:
 * default review rules first, then repo preamble, caller context,
 * and parent agent task/transcript when auto-spawned.
 */
export function buildReviewBackground(
  agent: Agent,
  repoPromptOverrides: RepoPromptOverrides | null,
  parentContext?: string | null,
  parentTask?: string | null,
): string {
  // Retry guard: a previous attempt persists its built background (which already
  // begins with DEFAULT_REVIEW_RULES) into review.background; rebuilds must not
  // stack the rules block again.
  const rawCallerBackground = agent.review?.background;
  const callerBackground =
    rawCallerBackground && rawCallerBackground.startsWith(DEFAULT_REVIEW_RULES)
      ? rawCallerBackground.slice(DEFAULT_REVIEW_RULES.length).trim()
      : rawCallerBackground;

  let bg = `${DEFAULT_REVIEW_RULES}\n\n`;

  if (repoPromptOverrides?.reviewBackground) {
    bg += `Repository Review Instructions: ${repoPromptOverrides.reviewBackground}\n\n`;
  }
  if (callerBackground) {
    bg += `Current Request Context: ${callerBackground}\n\n`;
  }

  if (agent.parentAgentId) {
    if (parentContext?.trim()) {
      bg += `Previous Activity Summary:\n${parentContext.trim()}\n\n`;
    } else if (!callerBackground && parentTask?.trim()) {
      bg += `Parent Agent Task: ${parentTask.trim()}\n\n`;
    }
  }

  return bg.trim();
}

export function buildAutoSpawnReviewBackground(
  parentAgent: Agent,
  parentTranscript: string,
): string {
  const parts: string[] = [];

  if (parentAgent.prompt?.trim()) {
    parts.push(`Task: ${parentAgent.prompt.trim()}`);
  }

  if (parentTranscript.trim()) {
    parts.push(`Transcript:\n${parentTranscript.trim()}`);
  }

  return parts.join('\n\n').trim();
}

export function readParentTranscriptLines(lines: string[], maxChars = 4000): string {
  const parts: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { role?: string; text?: string };
      if (entry.text?.trim()) {
        parts.push(`${entry.role || 'unknown'}: ${entry.text.trim()}`);
      }
    } catch {
      // skip malformed lines
    }
  }
  const joined = parts.join('\n');
  if (joined.length <= maxChars) {
    return joined;
  }
  return joined.slice(-maxChars);
}
