import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractOcrTokenUsage } from './token-usage';
import type { OcrReviewEnvelope } from './types';

describe('extractOcrTokenUsage', () => {
  it('extracts input and output tokens from OCR summary', () => {
    const result: OcrReviewEnvelope = {
      status: 'complete',
      summary: {
        files_reviewed: 2,
        comments: 0,
        total_tokens: 150878,
        input_tokens: 143016,
        output_tokens: 7862,
        elapsed: '5m2s',
      },
    };

    assert.deepEqual(extractOcrTokenUsage(result), {
      inputTokens: 143016,
      outputTokens: 7862,
    });
  });

  it('returns null when summary has no token fields', () => {
    const result: OcrReviewEnvelope = {
      status: 'partial',
      summary: { files_reviewed: 1, comments: 0 },
    };

    assert.equal(extractOcrTokenUsage(result), null);
  });

  it('returns null for legacy string summary', () => {
    const result: OcrReviewEnvelope = {
      summary: 'Looks good overall.',
    };

    assert.equal(extractOcrTokenUsage(result), null);
  });
});
