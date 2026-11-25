import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CodedError } from '../types';
import { assertPositiveInteger, validateAgentMode } from './validation';

describe('validateAgentMode', () => {
  it('defaults to batch', () => {
    assert.equal(validateAgentMode(undefined), 'batch');
    assert.equal(validateAgentMode(''), 'batch');
  });

  it('accepts batch and review', () => {
    assert.equal(validateAgentMode('batch'), 'batch');
    assert.equal(validateAgentMode('review'), 'review');
  });

  it('rejects modes removed in v1', () => {
    for (const mode of ['interactive', 'loop']) {
      assert.throws(
        () => validateAgentMode(mode),
        (err: unknown) => {
          assert.ok(err instanceof CodedError);
          assert.equal(err.code, 'VALIDATION_ERROR');
          assert.match(
            String(err.message),
            new RegExp(
              `mode "${mode}" was removed in v1; use "batch" \\(follow-ups are new batch runs on the same branch\\) or "review"`,
            ),
          );
          return true;
        },
      );
    }
  });

  it('rejects invalid mode', () => {
    assert.throws(
      () => validateAgentMode('invalid'),
      /mode must be "batch" or "review"/,
    );
  });
});

describe('assertPositiveInteger', () => {
  it('accepts positive integers', () => {
    assert.equal(assertPositiveInteger(1, 'count'), 1);
    assert.equal(assertPositiveInteger(42, 'count'), 42);
  });

  it('rejects non-integers and invalid values', () => {
    for (const value of [0, -1, 2.5, NaN, Infinity, '5']) {
      assert.throws(
        () => assertPositiveInteger(value, 'count'),
        (err: unknown) => {
          assert.ok(err instanceof CodedError);
          assert.equal(err.code, 'VALIDATION_ERROR');
          assert.match(String(err.message), /count must be a positive integer/);
          return true;
        },
      );
    }
  });
});
