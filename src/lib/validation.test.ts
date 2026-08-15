import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateAgentMode } from './validation';

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
