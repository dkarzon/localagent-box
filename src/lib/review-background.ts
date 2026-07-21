import type { Agent } from '../types';
import type { Repo } from '../types/index';

/**
 * Builds a concatenated background context for the OCR review process, 
 * merging repository-specific instructions, current request details, 
 * and historical context.
 */
export function buildReviewBackground(
  agent: Agent,
  repo: Repo | null
): string {
  let bg = '';

  // Include Repository-specific instructions if they exist from the configuration.
  if (repo?.reviewBackground) {
    bg += `Repository Review Instructions: ${repo.reviewBackground}\n\n`;
  }

  // Append current session context.
  if (agent.background) {
    bg += `Current Request Context: ${agent.background}\n\n`;
  }

  // If there's a parent agent, include an summary of its history to maintain continuity.
  if (agent.parentAgentId) {
    bg += `Previous Activity Summary: ${(agent as any).parentContext || 'N/A'}\n\n`;
  }

  return bg.trim();
}
