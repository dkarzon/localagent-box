import type { AgentTokenUsage } from '../api/types';

interface OcrRunSummary {
  input_tokens?: number;
  output_tokens?: number;
}

export function extractOcrTokenUsage(result: Record<string, unknown>): AgentTokenUsage | null {
  const summary = result.summary;
  if (!summary || typeof summary !== 'object') {
    return null;
  }

  const stats = summary as OcrRunSummary;
  const inputTokens = stats.input_tokens ?? 0;
  const outputTokens = stats.output_tokens ?? 0;
  if (inputTokens === 0 && outputTokens === 0) {
    return null;
  }

  return { inputTokens, outputTokens };
}
