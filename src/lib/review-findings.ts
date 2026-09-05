import type { OcrReviewEnvelope } from '../integrations/open-code-review/types';
import type { ReviewFindingRecord } from '../types';

export type ReviewFindingSeverity = ReviewFindingRecord['severity'];

export const SEVERITY_RANK: Record<'critical' | 'high' | 'medium' | 'low', number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const KNOWN_SEVERITIES = new Set(Object.keys(SEVERITY_RANK));

export type AutofixSeverityThresholdPolicy = 'disabled' | 'critical' | 'high' | 'medium' | 'low';

const THRESHOLD_RANK: Record<Exclude<AutofixSeverityThresholdPolicy, 'disabled'>, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export const MIN_BATCH_SIZE = 1;
export const MAX_BATCH_SIZE = 20;
export const DEFAULT_BATCH_SIZE = 5;

/** Zero-based ordinal within one OCR result, in the order OCR emitted them. */
function findOcrComments(result: OcrReviewEnvelope): Array<{
  path?: string;
  file?: string;
  content: string;
  start_line?: number;
  end_line?: number;
  suggestion_code?: string;
  existing_code?: string;
  severity?: string;
  category?: string;
}> {
  if (Array.isArray(result.comments) && result.comments.length > 0) {
    return result.comments.filter((comment) => typeof comment.content === 'string');
  }

  if (Array.isArray(result.issues)) {
    return result.issues
      .filter((issue) => typeof issue.message === 'string')
      .map((issue) => ({
        file: issue.file,
        content: issue.message,
        start_line: issue.line,
      }));
  }

  return [];
}

/**
 * Normalizes OCR review output into structured finding records.
 *
 * - IDs are deterministic within one review: `<reviewAgentId>:finding:<ordinal>`.
 * - `ordinal` preserves the original OCR order (zero-based) before any sorting.
 * - Missing/unknown severities become `'unknown'`; they are never auto-eligible.
 * - GitHub linkage starts empty with `not_applicable` resolution status.
 */
export function normalizeReviewFindings(
  reviewAgentId: string,
  ocrResult: OcrReviewEnvelope,
  reviewedSha: string | null,
): ReviewFindingRecord[] {
  const comments = findOcrComments(ocrResult);

  return comments
    .filter((comment) => comment.content.trim().length > 0)
    .map((comment, ordinal) => {
      const rawSeverity = comment.severity?.trim().toLowerCase();
      const severity: ReviewFindingSeverity = KNOWN_SEVERITIES.has(rawSeverity || '')
        ? (rawSeverity as ReviewFindingSeverity)
        : 'unknown';
      const rawCategory = comment.category?.trim().toLowerCase();
      const path = (comment.path || comment.file || '').trim() || null;
      const startLine =
        typeof comment.start_line === 'number' && Number.isFinite(comment.start_line)
          ? comment.start_line
          : null;
      const endLine =
        typeof comment.end_line === 'number' && Number.isFinite(comment.end_line)
          ? comment.end_line
          : startLine;

      return {
        id: `${reviewAgentId}:finding:${ordinal}`,
        ordinal,
        severity,
        category: rawCategory || null,
        path,
        startLine,
        endLine,
        content: comment.content,
        existingCode: comment.existing_code?.trim() || null,
        suggestionCode: comment.suggestion_code?.trim() || null,
        reviewedSha,
        fixStatus: 'available' as const,
        assignedAgentId: null,
        fixedAt: null,
        github: {
          reviewId: null,
          commentId: null,
          commentUrl: null,
          threadId: null,
          resolutionStatus: 'not_applicable' as const,
          resolutionError: null,
          resolvedAt: null,
        },
      };
    });
}

/**
 * Inclusive threshold check. `disabled` selects nothing and unknown/missing
 * severities are never automatic (Manual Fix remains available).
 */
export function isFindingAutoEligible(
  finding: Pick<ReviewFindingRecord, 'severity'>,
  threshold: AutofixSeverityThresholdPolicy,
): boolean {
  if (threshold === 'disabled') {
    return false;
  }
  const rank = SEVERITY_RANK[finding.severity as 'critical' | 'high' | 'medium' | 'low'];
  if (rank === undefined) {
    return false;
  }
  return rank >= THRESHOLD_RANK[threshold];
}

/** Sorts by descending severity rank; equal ranks keep original OCR ordinal order. */
export function sortFindingsForAutofix<T extends Pick<ReviewFindingRecord, 'severity' | 'ordinal'>>(
  findings: T[],
): T[] {
  return [...findings].sort((a, b) => {
    const rankA = SEVERITY_RANK[a.severity as 'critical' | 'high' | 'medium' | 'low'] ?? 0;
    const rankB = SEVERITY_RANK[b.severity as 'critical' | 'high' | 'medium' | 'low'] ?? 0;
    if (rankA !== rankB) {
      return rankB - rankA;
    }
    return a.ordinal - b.ordinal;
  });
}

/**
 * Defensively clamps persisted/invalid batch sizes to the valid 1–20 range,
 * defaulting to 5 when the value is not a usable integer.
 */
export function clampBatchSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return DEFAULT_BATCH_SIZE;
  }
  if (value < MIN_BATCH_SIZE) {
    return MIN_BATCH_SIZE;
  }
  if (value > MAX_BATCH_SIZE) {
    return MAX_BATCH_SIZE;
  }
  return value;
}

/** Splits ordered findings into sequential batches of at most `maxFindingsPerBatch`. */
export function splitFindingsIntoBatches<T>(
  findings: T[],
  maxFindingsPerBatch: unknown,
): T[][] {
  const size = clampBatchSize(maxFindingsPerBatch);
  const batches: T[][] = [];
  for (let index = 0; index < findings.length; index += size) {
    batches.push(findings.slice(index, index + size));
  }
  return batches;
}