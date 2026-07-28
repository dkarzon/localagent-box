import type { Agent } from '../types';
import type { RepoPromptOverrides } from '../types';

/**
 * Builds concatenated background context for OCR review:
 * repo preamble, caller context, and parent agent task/transcript when auto-spawned.
 */
export function buildReviewBackground(
  agent: Agent,
  repoPromptOverrides: RepoPromptOverrides | null,
  parentContext?: string | null,
): string {
  let bg = '';

  if (repoPromptOverrides?.reviewBackground) {
    bg += `Repository Review Instructions: ${repoPromptOverrides.reviewBackground}\n\n`;
  }

  const callerBackground = agent.review?.background;
  if (callerBackground) {
    bg += `Current Request Context: ${callerBackground}\n\n`;
  }

  if (agent.parentAgentId) {
    if (parentContext?.trim()) {
      bg += `Previous Activity Summary:\n${parentContext.trim()}\n\n`;
    } else if (!callerBackground && agent.prompt?.trim()) {
      bg += `Parent Agent Task: ${agent.prompt.trim()}\n\n`;
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
