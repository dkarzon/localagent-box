import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentJob, AppConfig } from '../../../types';
import { resolveReviewRunConfig } from './review-run-flow';

describe('resolveReviewRunConfig', () => {
  const baseConfig = {
    ollamaBaseUrl: 'http://localhost:11434',
    opencodeModel: 'qwen2.5-coder:7b',
    reviewModel: 'llama3.2',
  } as AppConfig;

  it('overrides reviewModel when job.model is set', () => {
    const job = { model: 'mistral:7b' } as AgentJob;
    const resolved = resolveReviewRunConfig(baseConfig, job);
    assert.equal(resolved.reviewModel, 'mistral:7b');
    assert.equal(resolved.opencodeModel, 'qwen2.5-coder:7b');
  });

  it('returns config unchanged when job.model is absent', () => {
    const job = {} as AgentJob;
    const resolved = resolveReviewRunConfig(baseConfig, job);
    assert.equal(resolved, baseConfig);
  });
});
