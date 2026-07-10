import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isBatchTurnComplete, isSessionIdle } from './session-runner';

describe('isSessionIdle', () => {
  it('treats missing session entry as idle', () => {
    assert.equal(isSessionIdle({}, 'sess-1'), true);
  });

  it('treats busy and retry as not idle', () => {
    assert.equal(isSessionIdle({ 'sess-1': { type: 'busy' } }, 'sess-1'), false);
    assert.equal(isSessionIdle({ 'sess-1': { type: 'retry' } }, 'sess-1'), false);
  });
});

describe('isBatchTurnComplete', () => {
  const sessionId = 'sess-abc';

  it('does not complete before task prompt busy', () => {
    assert.equal(isBatchTurnComplete({}, sessionId, false), false);
    assert.equal(isBatchTurnComplete({ [sessionId]: { type: 'busy' } }, sessionId, false), false);
  });

  it('completes when busy was seen and session entry is gone (OpenCode idle)', () => {
    assert.equal(isBatchTurnComplete({}, sessionId, true), true);
  });

  it('completes when busy was seen and status is idle', () => {
    assert.equal(
      isBatchTurnComplete({ [sessionId]: { type: 'idle' } }, sessionId, true),
      true,
    );
  });

  it('does not complete while still busy', () => {
    assert.equal(
      isBatchTurnComplete({ [sessionId]: { type: 'busy' } }, sessionId, true),
      false,
    );
  });
});
