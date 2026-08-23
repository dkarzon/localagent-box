import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertPositiveInteger, validateAgentMode } from './validation';

describe('validateAgentMode', () => {
  it('defaults to batch', () => {
    assert.equal(validateAgentMode(undefined), 'batch');
    assert.equal(validateAgentMode(''), 'batch');
  });

  it('accepts batch, interactive, loop, and review', () => {
    assert.equal(validateAgentMode('batch'), 'batch');
    assert.equal(validateAgentMode('interactive'), 'interactive');
    assert.equal(validateAgentMode('loop'), 'loop');
    assert.equal(validateAgentMode('review'), 'review');
  });

  it('rejects invalid mode', () => {
    assert.throws(() => validateAgentMode('invalid'));
  });
});

describe('assertPositiveInteger', () => {
  it('accepts positive integers', () => {
    assert.equal(assertPositiveInteger(1, 'count'), 1);
    assert.equal(assertPositiveInteger(42, 'count'), 42);
  });

  it('rejects non-integers and invalid values', () => {
    for (const value of [0, -1, 2.5, NaN, Infinity, '5']) {
      assert.throws(() => assertPositiveInteger(value, 'count'), /count must be a positive integer/);
    }
  });
});
