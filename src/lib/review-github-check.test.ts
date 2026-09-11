import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ReviewFindingRecord } from '../types';
import {
  REVIEW_CHECK_NAME,
  allFindingsCleared,
  checkOutputForComplete,
  checkOutputForInProgress,
  conclusionForReviewComplete,
  isFindingCleared,
} from './review-github-check';

function makeFinding(overrides: {
  fixStatus?: ReviewFindingRecord['fixStatus'];
  resolutionStatus?: ReviewFindingRecord['github']['resolutionStatus'];
}): Pick<ReviewFindingRecord, 'id' | 'fixStatus' | 'github'> {
  return {
    id: 'rev1:finding:0',
    fixStatus: overrides.fixStatus ?? 'available',
    github: {
      reviewId: null,
      commentId: null,
      commentUrl: null,
      threadId: null,
      resolutionStatus: overrides.resolutionStatus ?? 'not_applicable',
      resolutionError: null,
      resolvedAt: null,
    },
  };
}

describe('REVIEW_CHECK_NAME', () => {
  it('is the stable required-check name', () => {
    assert.equal(REVIEW_CHECK_NAME, 'localagent-box / review');
  });
});

describe('isFindingCleared', () => {
  it('is true for fixed findings and resolved threads', () => {
    assert.equal(isFindingCleared(makeFinding({ fixStatus: 'fixed' })), true);
    assert.equal(isFindingCleared(makeFinding({ resolutionStatus: 'resolved' })), true);
  });

  it('is false for available findings and unresolved threads', () => {
    assert.equal(isFindingCleared(makeFinding({ fixStatus: 'available' })), false);
    assert.equal(isFindingCleared(makeFinding({ fixStatus: 'failed' })), false);
    assert.equal(isFindingCleared(makeFinding({ resolutionStatus: 'pending' })), false);
    assert.equal(isFindingCleared(makeFinding({ resolutionStatus: 'not_applicable' })), false);
  });
});

describe('allFindingsCleared', () => {
  it('is true for an empty findings list', () => {
    assert.equal(allFindingsCleared([]), true);
  });

  it('is false when one finding is not cleared', () => {
    const findings = [
      makeFinding({ fixStatus: 'fixed' }),
      makeFinding({ fixStatus: 'available' }),
    ];
    assert.equal(allFindingsCleared(findings), false);
  });

  it('keeps action_required for unresolved not_applicable findings', () => {
    const findings = [makeFinding({ resolutionStatus: 'not_applicable' })];
    assert.equal(allFindingsCleared(findings), false);
  });

  it('is true for resolved-only findings', () => {
    const findings = [
      makeFinding({ resolutionStatus: 'resolved' }),
      makeFinding({ resolutionStatus: 'resolved' }),
    ];
    assert.equal(allFindingsCleared(findings), true);
  });

  it('is true for fixed-only findings', () => {
    const findings = [makeFinding({ fixStatus: 'fixed' })];
    assert.equal(allFindingsCleared(findings), true);
  });

  it('is true for a mix of fixed and resolved findings', () => {
    const findings = [
      makeFinding({ fixStatus: 'fixed' }),
      makeFinding({ resolutionStatus: 'resolved' }),
    ];
    assert.equal(allFindingsCleared(findings), true);
  });
});

describe('conclusionForReviewComplete', () => {
  it('returns success with no findings', () => {
    assert.equal(conclusionForReviewComplete([]), 'success');
  });

  it('returns action_required with at least one finding', () => {
    assert.equal(
      conclusionForReviewComplete([makeFinding({ fixStatus: 'available' })]),
      'action_required',
    );
  });
});

describe('checkOutputForInProgress', () => {
  it('has a running title and summary', () => {
    const output = checkOutputForInProgress();
    assert.equal(output.title, 'Review in progress');
    assert.ok(output.summary);
  });
});

describe('checkOutputForComplete', () => {
  it('describes a passing review', () => {
    const output = checkOutputForComplete({ conclusion: 'success', findings: [] });
    assert.equal(output.title, 'Review passed');
    assert.match(output.summary || '', /No findings/);
  });

  it('counts findings requiring attention', () => {
    const output = checkOutputForComplete({
      conclusion: 'action_required',
      findings: [
        { id: 'f0', severity: 'high', content: 'a' },
        { id: 'f1', severity: 'low', content: 'b' },
      ],
    });
    assert.equal(output.title, 'Review found issues');
    assert.match(output.summary || '', /2 finding\(s\)/);
  });

  it('appends summary markdown when provided', () => {
    const output = checkOutputForComplete({
      conclusion: 'action_required',
      findings: [{ id: 'f0', severity: 'high', content: 'a' }],
      summaryMarkdown: '## Summary\nDetails here',
    });
    assert.match(output.summary || '', /## Summary/);
  });

  it('uses the summary override for worker-crash failures', () => {
    const output = checkOutputForComplete({
      conclusion: 'failure',
      findings: [],
      summary: 'Worker error: boom',
    });
    assert.equal(output.title, 'Review failed');
    assert.match(output.summary || '', /boom/);
    assert.doesNotMatch(output.summary || '', /could not complete/);
  });

  it('describes cancellation', () => {
    const output = checkOutputForComplete({ conclusion: 'cancelled', findings: [] });
    assert.equal(output.title, 'Review cancelled');
  });
});