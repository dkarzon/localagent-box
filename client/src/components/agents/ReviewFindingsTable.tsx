import { useMemo, useState } from 'react';
import type {
  ReviewAutofixPlan,
  ReviewFindingRecord,
  ReviewFindingFixStatus,
} from '../../api/types';

type TableSort = 'severity' | 'ordinal';

const SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const severityBadgeVariant: Record<string, 'failed' | 'completing' | 'queued' | 'neutral'> = {
  critical: 'failed',
  high: 'completing',
  medium: 'queued',
  low: 'neutral',
  unknown: 'neutral',
};

const fixStatusBadgeVariant: Record<ReviewFindingFixStatus, string> = {
  available: 'neutral',
  assigned: 'queued',
  fixing: 'running',
  fixed: 'verified',
  failed: 'error',
};

function locationLabel(finding: ReviewFindingRecord): string {
  if (!finding.path) return '—';
  if (finding.startLine == null) return finding.path;
  if (finding.endLine != null && finding.endLine !== finding.startLine) {
    return `${finding.path}:${finding.startLine}–${finding.endLine}`;
  }
  return `${finding.path}:${finding.startLine}`;
}

function severityWeight(finding: ReviewFindingRecord, sort: TableSort): number {
  if (sort === 'ordinal') return -finding.ordinal;
  return SEVERITY_RANK[finding.severity] ?? 0;
}

export function sortFindingsForTable(
  findings: ReviewFindingRecord[],
  sort: TableSort,
): ReviewFindingRecord[] {
  return [...findings].sort((a, b) => {
    const weightA = severityWeight(a, sort);
    const weightB = severityWeight(b, sort);
    if (weightA !== weightB) return weightB - weightA;
    return a.ordinal - b.ordinal;
  });
}

export interface FindingsFilters {
  severity: string;
  category: string;
  fixStatus: string;
}

function applyFilters(
  findings: ReviewFindingRecord[],
  filters: FindingsFilters,
): ReviewFindingRecord[] {
  return findings.filter(
    (finding) =>
      (filters.severity === 'all' || finding.severity === filters.severity) &&
      (filters.category === 'all' || (finding.category ?? 'unknown') === filters.category) &&
      (filters.fixStatus === 'all' || finding.fixStatus === filters.fixStatus),
  );
}

interface ReviewFindingsTableProps {
  findings: ReviewFindingRecord[];
  staleReview?: boolean;
  plan?: ReviewAutofixPlan | null;
  /** Present when the caller supports resuming a paused automatic chain. */
  onResume?: (() => void) | null;
  resumeBusy?: boolean;
  /** Present when the caller supports queueing a fix agent for one finding. */
  onManualFix?: ((findingId: string) => void) | null;
  /** Finding ID currently being sent to the manual-fix endpoint. */
  manualFixBusyId?: string | null;
}

const chainStatusLabel: Record<ReviewAutofixPlan['chainStatus'], string> = {
  disabled: 'Autofix off',
  running: 'Autofix running',
  paused: 'Autofix paused',
  completed: 'Autofix completed',
};

export function ReviewFindingsTable({
  findings,
  staleReview,
  plan,
  onResume,
  resumeBusy = false,
  onManualFix,
  manualFixBusyId = null,
}: ReviewFindingsTableProps) {
  const [sort, setSort] = useState<TableSort>('severity');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filters, setFilters] = useState<FindingsFilters>({
    severity: 'all',
    category: 'all',
    fixStatus: 'all',
  });

  const categories = useMemo(
    () => [...new Set(findings.map((f) => f.category ?? 'unknown'))].sort(),
    [findings],
  );
  const fixStatuses = useMemo(
    () => [...new Set(findings.map((f) => f.fixStatus))],
    [findings],
  );

  const visible = useMemo(
    () => sortFindingsForTable(applyFilters(findings, filters), sort),
    [findings, filters, sort],
  );

  if (findings.length === 0) return null;

  const hasPendingBatches = Boolean(
    plan && plan.chainStatus === 'paused' && plan.batches.some((b) => b.status === 'pending'),
  );

  const selectClass =
    'rounded border border-outline-variant bg-surface-lowest px-2 py-1 text-xs text-on-surface';

  return (
    <section className="mt-4 rounded border border-surface-container-highest bg-surface-low">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-surface-container-highest px-4 py-3">
        <h3 className="text-sm font-medium text-primary">
          Review findings
          <span className="ml-2 text-on-surface-variant">({findings.length})</span>
          {plan && plan.chainStatus !== 'disabled' ? (
            <span className="ml-2 text-on-surface-variant text-xs">
              {chainStatusLabel[plan.chainStatus]}
              {plan.batches.length > 0 ? ` · ${plan.batches.length} batch(es)` : ''}
            </span>
          ) : null}
          {staleReview ? (
            <span className="ml-2 text-warning text-xs">
              Reviewed SHA no longer matches branch head
            </span>
          ) : null}
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          {onResume && hasPendingBatches ? (
            <button
              type="button"
              className="inline-flex items-center rounded border border-primary bg-transparent px-3 py-1 text-xs text-primary transition-colors hover:bg-surface-low disabled:cursor-not-allowed disabled:opacity-50"
              disabled={resumeBusy}
              onClick={onResume}
            >
              {resumeBusy ? 'Resuming…' : 'Resume Remaining Batches'}
            </button>
          ) : null}
          <select
            aria-label="Filter by severity"
            className={selectClass}
            value={filters.severity}
            onChange={(e) => setFilters((f) => ({ ...f, severity: e.target.value }))}
          >
            <option value="all">All severities</option>
            {['critical', 'high', 'medium', 'low', 'unknown'].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by category"
            className={selectClass}
            value={filters.category}
            onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value }))}
          >
            <option value="all">All categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by fix status"
            className={selectClass}
            value={filters.fixStatus}
            onChange={(e) => setFilters((f) => ({ ...f, fixStatus: e.target.value }))}
          >
            <option value="all">All statuses</option>
            {fixStatuses.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select
            aria-label="Sort findings"
            className={selectClass}
            value={sort}
            onChange={(e) => setSort(e.target.value === 'ordinal' ? 'ordinal' : 'severity')}
          >
            <option value="severity">Sort: severity</option>
            <option value="ordinal">Sort: OCR order</option>
          </select>
        </div>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr className="border-b border-surface-container-highest text-xs uppercase tracking-wide text-on-surface-variant">
              <th className="px-4 py-2 font-medium">Severity</th>
              <th className="px-4 py-2 font-medium">Category</th>
              <th className="px-4 py-2 font-medium">Finding</th>
              <th className="px-4 py-2 font-medium">Location</th>
              <th className="px-4 py-2 font-medium">GitHub thread</th>
              <th className="px-4 py-2 font-medium">Fix status</th>
              <th className="px-4 py-2 font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((finding) => (
              <FindingRow
                key={finding.id}
                finding={finding}
                expanded={expandedId === finding.id}
                onToggle={() => setExpandedId((id) => (id === finding.id ? null : finding.id))}
                onManualFix={onManualFix}
                manualFixBusy={manualFixBusyId === finding.id}
              />
            ))}
            {visible.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-on-surface-variant">
                  No findings match the current filters.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function FindingRow({
  finding,
  expanded,
  onToggle,
  onManualFix,
  manualFixBusy = false,
}: {
  finding: ReviewFindingRecord;
  expanded: boolean;
  onToggle: () => void;
  onManualFix?: ((findingId: string) => void) | null;
  manualFixBusy?: boolean;
}) {
  const badgeVariant = severityBadgeVariant[finding.severity] ?? 'neutral';
  const statusVariant = fixStatusBadgeVariant[finding.fixStatus] ?? 'neutral';
  const commentUrl = finding.github.commentUrl;
  const manualFixPending = finding.fixStatus === 'assigned' || finding.fixStatus === 'fixing';

  return (
    <>
      <tr
        className="cursor-pointer border-b border-surface-container-highest hover:bg-surface-container/40"
        onClick={onToggle}
      >
        <td className="px-4 py-2">
          <span
            className={`inline-flex rounded px-2 py-0.5 text-xs ${
              badgeVariant === 'failed'
                ? 'bg-error-container text-on-error-container'
                : badgeVariant === 'completing'
                  ? 'bg-primary-container text-on-primary-container'
                  : badgeVariant === 'queued'
                    ? 'bg-primary/10 text-primary'
                    : 'bg-surface-container text-on-surface-variant'
            }`}
          >
            {finding.severity}
          </span>
        </td>
        <td className="px-4 py-2 text-on-surface-variant">{finding.category ?? '—'}</td>
        <td className="max-w-[280px] px-4 py-2">
          <span className="line-clamp-2">{finding.content}</span>
        </td>
        <td className="px-4 py-2 font-mono text-xs text-on-surface-variant">
          {locationLabel(finding)}
        </td>
        <td className="px-4 py-2 text-xs">
          {commentUrl ? (
            <a
              href={commentUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              comment #{finding.github.commentId}
            </a>
          ) : (
            <span className="text-muted">—</span>
          )}
        </td>
        <td className="px-4 py-2">
          <span
            className={`inline-flex rounded px-2 py-0.5 text-xs ${
              statusVariant === 'verified'
                ? 'bg-success-container text-on-success-container'
                : statusVariant === 'error'
                  ? 'bg-error-container text-on-error-container'
                  : statusVariant === 'queued'
                    ? 'bg-primary/10 text-primary'
                    : 'bg-surface-container text-on-surface-variant'
            }`}
          >
            {finding.fixStatus}
          </span>
        </td>
        <td className="px-4 py-2 text-xs">
          {onManualFix && !manualFixPending ? (
            <button
              type="button"
              className="inline-flex items-center rounded border border-primary bg-transparent px-2 py-0.5 text-xs text-primary transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={manualFixBusy}
              title={
                finding.fixStatus === 'failed'
                  ? 'Queue a new fix agent for this finding'
                  : 'Queue an agent to fix this finding'
              }
              onClick={(e) => {
                e.stopPropagation();
                onManualFix(finding.id);
              }}
            >
              {manualFixBusy ? 'Queueing…' : finding.fixStatus === 'failed' ? 'Retry Fix' : 'Manual Fix'}
            </button>
          ) : manualFixPending ? (
            <span className="text-muted">Fix agent {finding.fixStatus}…</span>
          ) : (
            <span className="text-muted">—</span>
          )}
        </td>
      </tr>
      {expanded ? (
        <tr className="border-b border-surface-container-highest bg-surface-container/20">
          <td colSpan={7} className="px-4 py-4">
            <div className="grid gap-3 text-sm">
              <div className="whitespace-pre-wrap text-on-surface">{finding.content}</div>
              {finding.existingCode ? (
                <div>
                  <p className="label-md mb-1 text-on-surface-variant">Existing code</p>
                  <pre className="overflow-x-auto rounded bg-background p-3 code-md text-xs">
                    {finding.existingCode}
                  </pre>
                </div>
              ) : null}
              {finding.suggestionCode ? (
                <div>
                  <p className="label-md mb-1 text-on-surface-variant">Suggested code</p>
                  <pre className="overflow-x-auto rounded bg-background p-3 code-md text-xs">
                    {finding.suggestionCode}
                  </pre>
                </div>
              ) : null}
              {finding.reviewedSha ? (
                <p className="text-xs text-on-surface-variant">
                  Reviewed SHA: <span className="font-mono">{finding.reviewedSha.slice(0, 12)}</span>
                </p>
              ) : null}
              {finding.github.resolutionError ? (
                <p className="text-xs text-error">
                  Resolution error: {finding.github.resolutionError}
                </p>
              ) : null}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}