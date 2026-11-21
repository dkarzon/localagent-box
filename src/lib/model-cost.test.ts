import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  computeModelCost,
  hasModelTokenCost,
  resolveModelTokenCost,
  sanitizeModelTokenCosts,
} from './model-cost';

describe('resolveModelTokenCost', () => {
  const costs = {
    'llama3.2': { input: 1, output: 3 },
    'ollama/qwen3-coder:30b': { input: 0.5, output: 2 },
  };

  it('matches the exact key', () => {
    assert.deepEqual(resolveModelTokenCost(costs, 'llama3.2'), { input: 1, output: 3 });
  });

  it('matches provider-prefixed keys and ids either way', () => {
    assert.deepEqual(resolveModelTokenCost(costs, 'ollama/qwen3-coder:30b'), { input: 0.5, output: 2 });
    assert.deepEqual(resolveModelTokenCost(costs, 'openai-compatible/qwen3-coder:30b'), { input: 0.5, output: 2 });
    assert.deepEqual(resolveModelTokenCost(costs, 'ollama/llama3.2'), { input: 1, output: 3 });
  });

  it('returns null for models without an entry, even if a `*` key exists', () => {
    assert.equal(resolveModelTokenCost({ ...costs, '*': { input: 0.1 } }, 'unknown-model'), null);
    assert.equal(resolveModelTokenCost({}, 'llama3.2'), null);
  });
});

describe('computeModelCost', () => {
  it('prices input, output, and cache categories per million tokens', () => {
    const cost = computeModelCost(
      { input: 1, output: 3, cacheRead: 0.2 },
      { input: 2_000_000, output: 1_000_000, cacheRead: 500_000, cacheWrite: 0 },
    );
    assert.ok(Math.abs(cost - (2 + 3 + 0.1)) < 1e-9);
  });

  it('bills reasoning tokens at the output rate', () => {
    const cost = computeModelCost({ output: 2 }, { input: 0, output: 500_000, reasoning: 500_000, cacheRead: 0, cacheWrite: 0 });
    assert.ok(Math.abs(cost - 2) < 1e-9);
  });

  it('charges nothing for categories without a rate', () => {
    assert.equal(computeModelCost({ input: 5 }, { input: 0, output: 100, cacheRead: 100, cacheWrite: 100 }), 0);
  });

  it('ignores negative or non-finite rates', () => {
    assert.equal(computeModelCost({ input: -1 }, { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }), 0);
  });

  it('hasModelTokenCost ignores zero, negative, or missing rates', () => {
    assert.equal(hasModelTokenCost({ input: 0, output: 2 }), true);
    assert.equal(hasModelTokenCost({ input: 0 }), false);
    assert.equal(hasModelTokenCost({ input: -1 }), false);
    assert.equal(hasModelTokenCost(null), false);
  });
});

describe('sanitizeModelTokenCosts', () => {
  it('keeps only finite non-negative rates for known categories', () => {
    assert.deepEqual(
      sanitizeModelTokenCosts({
        ' llama3.2 ': { input: 0.2, output: '0.6', cacheRead: -1, cacheWrite: 0, bogus: 5 },
        qwen3: { output: 1 },
      }),
      { 'llama3.2': { input: 0.2, cacheWrite: 0 }, qwen3: { output: 1 } },
    );
  });

  it('drops non-object input, empty keys, and non-object entries', () => {
    assert.deepEqual(sanitizeModelTokenCosts('nope'), {});
    assert.deepEqual(sanitizeModelTokenCosts(null), {});
    assert.deepEqual(sanitizeModelTokenCosts([{ input: 1 }]), {});
    assert.deepEqual(sanitizeModelTokenCosts({ '': { input: 1 }, a: 5, b: null, c: [1] }), {});
  });
});
