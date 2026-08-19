import type { AgentTokenUsage } from '../../types';
import type { OcrReviewEnvelope } from './types';

function getRunStats(result: OcrReviewEnvelope) {
  if (typeof result.summary === 'object' && result.summary) {
    return result.summary;
  }
  return null;
}

export function extractOcrTokenUsage(result: OcrReviewEnvelope): AgentTokenUsage | null {
  const stats = getRunStats(result);
  if (!stats) {
    return null;
  }

  const inputTokens = stats.input_tokens ?? 0;
  const outputTokens = stats.output_tokens ?? 0;
  if (inputTokens === 0 && outputTokens === 0) {
    return null;
  }

  return { inputTokens, outputTokens };
}
