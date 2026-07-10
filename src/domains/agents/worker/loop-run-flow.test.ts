import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildLoopState, canCommitLoopOutstanding, LOOP_ACTIVE_STATUSES } from '../../../lib/loop-state';
import { parseCompletionSignal } from './loop-config';

describe('buildLoopState', () => {
  it('sets canFinish while loop is active', () => {
    const state = buildLoopState('processing', {
      iteration: 2,
      stepIndex: 1,
      currentVerb: 'ACT',
      stepsInIteration: 4,
      maxIterations: 10,
      completionMarker: 'LOOP_COMPLETE',
      configSource: 'server-default',
      effectiveSteps: [],
    });
    assert.equal(state.canFinish, true);
    assert.equal(state.finishRequested, false);
  });

  it('clears canFinish when completing', () => {
    const state = buildLoopState('completing', { iteration: 1 });
    assert.equal(state.canFinish, false);
  });

  it('preserves finishRequested from existing state', () => {
    const state = buildLoopState('processing', { finishRequested: true });
    assert.equal(state.finishRequested, true);
  });

  it('sets canCommitOutstanding for failed loop sessions with git changes', () => {
    const state = buildLoopState(
      'failed',
      { iteration: 3 },
      {
        status: 'failed',
        commitSha: null,
        gitStatus: { filesChanged: 2, files: [], updatedAt: '2026-06-09T00:00:00.000Z' },
      },
    );
    assert.equal(state.canCommitOutstanding, true);
    assert.equal(
      canCommitLoopOutstanding({
        status: 'failed',
        commitSha: null,
        gitStatus: { filesChanged: 2, files: [], updatedAt: '2026-06-09T00:00:00.000Z' },
      }),
      true,
    );
  });

  it('clears canCommitOutstanding after commit or without git changes', () => {
    assert.equal(
      canCommitLoopOutstanding({
        status: 'failed',
        commitSha: 'abc123',
        gitStatus: { filesChanged: 2, files: [], updatedAt: '2026-06-09T00:00:00.000Z' },
      }),
      false,
    );
    assert.equal(
      canCommitLoopOutstanding({
        status: 'failed',
        commitSha: null,
        gitStatus: { filesChanged: 0, files: [], updatedAt: '2026-06-09T00:00:00.000Z' },
      }),
      false,
    );
  });
});

describe('LOOP_ACTIVE_STATUSES', () => {
  it('matches batch-like active statuses', () => {
    assert.ok(LOOP_ACTIVE_STATUSES.has('processing'));
    assert.ok(LOOP_ACTIVE_STATUSES.has('running'));
    assert.ok(!LOOP_ACTIVE_STATUSES.has('awaiting_input'));
  });
});

describe('parseCompletionSignal (iteration cap scenarios)', () => {
  it('does not complete when REFLECT omits marker after max work', () => {
    const reflectOutput =
      'Progress made but goal not fully achieved.\nRemaining: add tests and update docs.';
    assert.equal(parseCompletionSignal(reflectOutput, 'LOOP_COMPLETE'), false);
  });

  it('completes when REFLECT emits marker after successful iteration', () => {
    const reflectOutput = 'All tasks done.\nLOOP_COMPLETE: true';
    assert.equal(parseCompletionSignal(reflectOutput, 'LOOP_COMPLETE'), true);
  });
});

describe('completion signal on non-REFLECT steps', () => {
  it('completes when ACT step emits marker', () => {
    const actOutput = 'Fix applied. Tests pass.\n\nLOOP_COMPLETE: true';
    assert.equal(parseCompletionSignal(actOutput, 'LOOP_COMPLETE'), true);
  });

  it('completes when OBSERVE step emits marker', () => {
    const observeOutput = 'Bug already fixed on this branch. LOOP_COMPLETE: true';
    assert.equal(parseCompletionSignal(observeOutput, 'LOOP_COMPLETE'), true);
  });

  it('does not complete if non-REFLECT step shows progress without marker', () => {
    const actOutput = 'Fix applied but tests still failing. Will debug.';
    assert.equal(parseCompletionSignal(actOutput, 'LOOP_COMPLETE'), false);
  });
});
