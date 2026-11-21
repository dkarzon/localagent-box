import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeModelCost, hasModelTokenCost, resolveModelTokenCost } from './model-cost';

describe('resolveModelTokenCost', () => {
  const costs = {
    'llama3.2': { input: 1, output: 3 },
    'ollama/qwen3-coder:30b': { input: 0.5, output: 2 },
    '*': { input: 0.1, output: 0.3 },
  };

  it('matches the exact key', () => {
    assert.deepEqual(resolveModelTokenCost(costs, 'llama3.2'), { input: 1, output: 3 });
  });

  it('matches provider-prefixed keys and ids either way', () => {
    assert.deepEqual(resolveModelTokenCost(costs, 'ollama/qwen3-coder:30b'), { input: 0.5, output: 2 });
    assert.deepEqual(resolveModelTokenCost(costs, 'openai-compatible/qwen3-coder:30b'), { input: 0.5, output: 2 });
  });

  it('falls back to the wildcard entry', () => {
    assert.deepEqual(resolveModelTokenCost(costs, 'unknown-model'), { input: 0.1, output: 0.3 });
  });

  it('returns null when nothing matches', () => {
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

  it('charges nothing for categories without a rate', () => {
    assert.equal(computeModelCost({ input: 5 }, { input: 0, output: 100, cacheRead: 100, cacheWrite: 100 }), 0);
  });

  it('hasModelTokenCost ignores zero or missing rates', () => {
    assert.equal(hasModelTokenCost({ input: 0, output: 2 }), true);
    assert.equal(hasModelTokenCost({ input: 0 }), false);
    assert.equal(hasModelTokenCost(null), false);
  });
});
