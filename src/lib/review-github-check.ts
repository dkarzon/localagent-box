import type { ReviewFindingRecord } from '../types';

/** Stable check-run name for every localagent-box review. */
export const REVIEW_CHECK_NAME = 'localagent-box / review';

export type ReviewCheckOutput = { title?: string; summary?: string };

/**
 * A finding counts as "cleared" when it is locally fixed or its GitHub
 * thread is resolved. Findings without a GitHub thread (not_applicable)
 * keep the check requiring attention until they are fixed locally.
 */
export function isFindingCleared(finding: Pick<ReviewFindingRecord, 'fixStatus' | 'github'>): boolean {
  return finding.fixStatus === 'fixed' || finding.github.resolutionStatus === 'resolved';
}

/** True when every finding is cleared; a review with no findings is trivially clear. */
export function allFindingsCleared(
  findings: ReadonlyArray<Pick<ReviewFindingRecord, 'fixStatus' | 'github'>>,
): boolean {
  return findings.every(isFindingCleared);
}

/** Conclusion at review completion: findings mean attention is required. */
export function conclusionForReviewComplete(
  findings: ReadonlyArray<Pick<ReviewFindingRecord, 'id' | 'fixStatus' | 'github'>>,
): 'success' | 'action_required' {
  return findings.length === 0 ? 'success' : 'action_required';
}

/** Output while the review is running. */
export function checkOutputForInProgress(): ReviewCheckOutput {
  return {
    title: 'Review in progress',
    summary: 'The review agent is analyzing the changes.',
  };
}

/**
 * Output when the review completes. `summaryMarkdown` (existing OCR summary
 * helpers) is appended after the standard title/verdict text; `summary`
 * replaces it entirely (worker crash path).
 */
export function checkOutputForComplete(params: {
  conclusion: 'success' | 'action_required' | 'failure' | 'cancelled';
  findings: ReadonlyArray<Pick<ReviewFindingRecord, 'id' | 'severity' | 'content'>>;
  summaryMarkdown?: string | null;
  summary?: string;
}): ReviewCheckOutput {
  const { conclusion, findings, summaryMarkdown, summary } = params;

  let title: string;
  let summaryText: string;
  if (conclusion === 'success') {
    title = 'Review passed';
    summaryText = 'No findings were reported.';
  } else if (conclusion === 'action_required') {
    title = 'Review found issues';
    const count = findings.length;
    summaryText = `${count} finding(s) require attention. Open the localagent-box review for details and fixes.`;
  } else if (conclusion === 'failure') {
    title = 'Review failed';
    summaryText = 'The review agent could not complete the analysis.';
  } else {
    title = 'Review cancelled';
    summaryText = 'The review was cancelled or interrupted.';
  }

  const override = summary?.trim();
  if (override) {
    summaryText = override;
  } else {
    const trimmed = summaryMarkdown?.trim();
    if (trimmed) {
      summaryText = `${summaryText}\n\n${trimmed}`;
    }
  }
  return { title, summary: summaryText };
}