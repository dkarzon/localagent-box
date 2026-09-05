import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clampBatchSize,
  isFindingAutoEligible,
  normalizeReviewFindings,
  sortFindingsForAutofix,
  splitFindingsIntoBatches,
} from './review-findings';
import type { ReviewFindingRecord } from '../types';

function finding(severity: ReviewFindingRecord['severity'], ordinal: number): ReviewFindingRecord {
  return {
    id: `review-1:finding:${ordinal}`,
    ordinal,
    severity,
    category: null,
    path: null,
    startLine: null,
    endLine: null,
    content: `finding ${ordinal}`,
    existingCode: null,
    suggestionCode: null,
    reviewedSha: null,
    fixStatus: 'available',
    assignedAgentId: null,
    fixedAt: null,
    github: {
      reviewId: null,
      commentId: null,
      commentUrl: null,
      threadId: null,
      resolutionStatus: 'not_applicable',
      resolutionError: null,
      resolvedAt: null,
    },
  };
}

test('normalizeReviewFindings assigns deterministic ids and OCR ordinals', () => {
  const result = normalizeReviewFindings(
    'review-1',
    {
      comments: [
        { content: 'first', severity: 'high', path: 'a.ts', start_line: 1, end_line: 2 },
        { content: 'second', path: 'b.ts' },
      ],
    },
    'sha123',
  );

  assert.equal(result.length, 2);
  assert.equal(result[0].id, 'review-1:finding:0');
  assert.equal(result[1].id, 'review-1:finding:1');
  assert.equal(result[0].ordinal, 0);
  assert.equal(result[1].ordinal, 1);
  assert.equal(result[0].severity, 'high');
  assert.equal(result[0].reviewedSha, 'sha123');
  assert.equal(result[0].fixStatus, 'available');
  assert.equal(result[0].github.resolutionStatus, 'not_applicable');
  assert.equal(result[1].severity, 'unknown');
});

test('normalizeReviewFindings maps legacy issues and drops empty content', () => {
  const result = normalizeReviewFindings(
    'review-2',
    {
      issues: [
        { file: 'legacy.ts', line: 7, message: 'legacy issue' },
        { message: '   ' },
      ],
    },
    null,
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'review-2:finding:0');
  assert.equal(result[0].path, 'legacy.ts');
  assert.equal(result[0].startLine, 7);
  assert.equal(result[0].endLine, 7);
  assert.equal(result[0].severity, 'unknown');
  assert.equal(result[0].reviewedSha, null);
});

test('isFindingAutoEligible: disabled selects nothing', () => {
  assert.equal(isFindingAutoEligible(finding('critical', 0), 'disabled'), false);
});

test('isFindingAutoEligible: unknown severity never eligible', () => {
  for (const threshold of ['critical', 'high', 'medium', 'low'] as const) {
    assert.equal(isFindingAutoEligible(finding('unknown', 0), threshold), false);
  }
});

test('isFindingAutoEligible: high threshold is inclusive of critical', () => {
  assert.equal(isFindingAutoEligible(finding('critical', 0), 'high'), true);
  assert.equal(isFindingAutoEligible(finding('high', 1), 'high'), true);
  assert.equal(isFindingAutoEligible(finding('medium', 2), 'high'), false);
  assert.equal(isFindingAutoEligible(finding('low', 3), 'high'), false);
});

test('isFindingAutoEligible: medium and low thresholds are inclusive downward only', () => {
  assert.equal(isFindingAutoEligible(finding('low', 0), 'medium'), false);
  assert.equal(isFindingAutoEligible(finding('medium', 1), 'medium'), true);
  assert.equal(isFindingAutoEligible(finding('high', 1), 'medium'), true);
  assert.equal(isFindingAutoEligible(finding('low', 2), 'low'), true);
  assert.equal(isFindingAutoEligible(finding('critical', 3), 'low'), true);
});

test('sortFindingsForAutofix orders by severity then preserves OCR ordinal', () => {
  const sorted = sortFindingsForAutofix([
    finding('low', 4),
    finding('high', 1),
    finding('critical', 2),
    finding('high', 0),
    finding('unknown', 5),
    finding('critical', 3),
  ]);

  assert.deepEqual(
    sorted.map((item) => item.ordinal),
    [2, 3, 0, 1, 4, 5],
  );
});

test('splitFindingsIntoBatches: twelve findings split 5/5/2', () => {
  const findings = Array.from({ length: 12 }, (_, index) => finding('high', index));
  const batches = splitFindingsIntoBatches(findings, 5);

  assert.equal(batches.length, 3);
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [5, 5, 2],
  );
});

test('splitFindingsIntoBatches clamps invalid batch sizes', () => {
  const findings = Array.from({ length: 7 }, (_, index) => finding('high', index));

  assert.equal(splitFindingsIntoBatches(findings, 0).length, 7);
  assert.equal(splitFindingsIntoBatches(findings, -3).length, 7);
  assert.equal(splitFindingsIntoBatches(findings, 50).length, 1);
  assert.equal(splitFindingsIntoBatches(findings, 'bad').length, 2);
  assert.deepEqual(splitFindingsIntoBatches([], 5), []);
});

test('clampBatchSize defaults and clamps invalid values', () => {
  assert.equal(clampBatchSize(undefined), 5);
  assert.equal(clampBatchSize(null), 5);
  assert.equal(clampBatchSize('x'), 5);
  assert.equal(clampBatchSize(2.5), 5);
  assert.equal(clampBatchSize(0), 1);
  assert.equal(clampBatchSize(1), 1);
  assert.equal(clampBatchSize(20), 20);
  assert.equal(clampBatchSize(21), 20);
});