import type { OcrComment, OcrCoverageItem, OcrReviewEnvelope } from './types';

export function normalizeComments(result: OcrReviewEnvelope): OcrComment[] {
  if (Array.isArray(result.comments) && result.comments.length > 0) {
    return result.comments.filter((comment) => comment.content?.trim());
  }

  if (Array.isArray(result.issues)) {
    return result.issues
      .filter((issue) => issue.message?.trim())
      .map((issue) => ({
        path: issue.file || 'unknown',
        content: issue.message,
        start_line: issue.line,
      }));
  }

  return [];
}

function getRunStats(result: OcrReviewEnvelope) {
  if (typeof result.summary === 'object' && result.summary) {
    return result.summary;
  }
  return null;
}

function getCoverage(result: OcrReviewEnvelope) {
  return result.manifest?.coverage;
}

function getReviewedFilePaths(result: OcrReviewEnvelope): string[] {
  const coverage = getCoverage(result);
  const fromCompleted = (coverage?.completed || [])
    .map((item) => item.path)
    .filter((path): path is string => Boolean(path));

  if (fromCompleted.length > 0) {
    return [...new Set(fromCompleted)];
  }

  const fromCoverage = (coverage?.selected || [])
    .map((item) => item.path)
    .filter((path): path is string => Boolean(path));

  if (fromCoverage.length > 0) {
    return [...new Set(fromCoverage)];
  }

  return [
    ...new Set(
      normalizeComments(result)
        .map((comment) => comment.path || comment.file)
        .filter(Boolean) as string[],
    ),
  ];
}

function formatLocation(comment: OcrComment): string {
  const filePath = comment.path || comment.file || 'unknown';
  const start = comment.start_line;
  const end = comment.end_line;

  if (typeof start === 'number' && start > 0) {
    if (typeof end === 'number' && end > 0 && end !== start) {
      return `\`${filePath}:${start}-${end}\``;
    }
    return `\`${filePath}:${start}\``;
  }

  return `\`${filePath}\``;
}

function formatNumber(value: number | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return value.toLocaleString('en-US');
}

function formatFailedItem(item: OcrCoverageItem): string {
  const label = item.old_path ? `\`${item.path}\` (was \`${item.old_path}\`)` : `\`${item.path}\``;
  const detail = [item.classification, item.reason].filter(Boolean).join(': ');
  return detail ? `- ${label} — ${detail}` : `- ${label}`;
}

function headlineFor(
  result: OcrReviewEnvelope,
  findingCount: number,
  filesReviewed: number,
  failedCount: number,
): string {
  const message = result.message?.trim();
  const legacySummary = typeof result.summary === 'string' ? result.summary.trim() : '';
  const status = result.status || result.manifest?.terminal_state;

  if (status === 'skipped') {
    return `⚠️ **Skipped** — ${message || legacySummary || 'No files eligible for review.'}`;
  }

  if (status === 'partial' || failedCount > 0) {
    if (message) {
      return `⚠️ **Review partially complete** — ${message}`;
    }
    return `⚠️ **Review partially complete** — ${findingCount} finding(s); ${failedCount} file(s) failed.`;
  }

  if (findingCount === 0) {
    if (message) {
      return `✅ **No issues found** — ${message}`;
    }
    if (legacySummary) {
      return `✅ **No issues found** — ${legacySummary}`;
    }
    return `✅ **No issues found** — review complete across ${filesReviewed} file(s).`;
  }

  if (message) {
    return `🔍 **${findingCount} finding(s)** — ${message}`;
  }

  return `🔍 **${findingCount} finding(s)** across ${filesReviewed} file(s).`;
}

function appendCoverageSummary(lines: string[], result: OcrReviewEnvelope): void {
  const coverage = getCoverage(result);
  if (!coverage) {
    return;
  }

  const selected = coverage.selected?.length ?? 0;
  const completed = coverage.completed?.length ?? 0;
  const failed = coverage.failed?.length ?? 0;
  const waived = coverage.waived?.length ?? 0;
  const reused = coverage.reused?.length ?? 0;

  if (selected + completed + failed + waived + reused === 0) {
    return;
  }

  lines.push('', '### Coverage', '');
  lines.push('| | Count |');
  lines.push('| --- | ---: |');
  if (selected > 0) lines.push(`| Selected | ${selected} |`);
  if (completed > 0) lines.push(`| Completed | ${completed} |`);
  if (failed > 0) lines.push(`| Failed | ${failed} |`);
  if (waived > 0) lines.push(`| Waived | ${waived} |`);
  if (reused > 0) lines.push(`| Reused | ${reused} |`);
}

function appendRunStats(lines: string[], result: OcrReviewEnvelope): void {
  const stats = getRunStats(result);
  if (!stats) {
    return;
  }

  const rows: string[] = [];
  if (typeof stats.files_reviewed === 'number') {
    rows.push(`| Files reviewed | ${stats.files_reviewed} |`);
  }
  if (typeof stats.comments === 'number') {
    rows.push(`| Findings | ${stats.comments} |`);
  }
  if (stats.elapsed) {
    rows.push(`| Elapsed | ${stats.elapsed} |`);
  }
  const totalTokens = formatNumber(stats.total_tokens);
  const inputTokens = formatNumber(stats.input_tokens);
  const outputTokens = formatNumber(stats.output_tokens);
  if (totalTokens) {
    const tokenDetail =
      inputTokens && outputTokens ? ` (${inputTokens} in / ${outputTokens} out)` : '';
    rows.push(`| Tokens | ${totalTokens}${tokenDetail} |`);
  }

  if (rows.length === 0) {
    return;
  }

  lines.push('', '### Run stats', '', '| Metric | Value |', '| --- | --- |', ...rows);
}

function appendBranchRange(lines: string[], result: OcrReviewEnvelope): void {
  const input = result.manifest?.input;
  if (!input?.requested_from && !input?.requested_head) {
    return;
  }

  const range = input.requested_from && input.requested_head
    ? `\`${input.requested_from}\` → \`${input.requested_head}\``
    : null;

  lines.push('', '### Branch range', '');
  if (range) {
    lines.push(range);
  }
  if (input.exact_range) {
    lines.push('', `Commit range: \`${input.exact_range}\``);
  }
}

function appendToolCalls(lines: string[], result: OcrReviewEnvelope): void {
  const toolCalls = result.tool_calls;
  if (!toolCalls?.total && !toolCalls?.by_tool) {
    return;
  }

  lines.push('', '### Tool usage', '');
  if (typeof toolCalls.total === 'number') {
    lines.push(`Total tool calls: ${toolCalls.total}`);
  }
  if (toolCalls.by_tool) {
    const parts = Object.entries(toolCalls.by_tool)
      .sort((a, b) => b[1] - a[1])
      .map(([tool, count]) => `${tool} (${count})`);
    if (parts.length > 0) {
      lines.push(parts.join(' · '));
    }
  }
}

function appendFindingBody(lines: string[], comment: OcrComment): void {
  lines.push(comment.content.trim());

  if (comment.suggestion_code?.trim()) {
    lines.push('', '**Suggestion:**', '```suggestion', comment.suggestion_code.trim(), '```');
  } else if (comment.existing_code?.trim()) {
    lines.push('', '**Referenced code:**', '```', comment.existing_code.trim(), '```');
  }

  if (comment.thinking?.trim()) {
    lines.push(
      '',
      '<details>',
      '<summary>Reasoning</summary>',
      '',
      comment.thinking.trim(),
      '',
      '</details>',
    );
  }
}

function appendFinding(lines: string[], comment: OcrComment): void {
  lines.push(`#### ${formatLocation(comment)}`, '');
  appendFindingBody(lines, comment);
  lines.push('');
}

export function formatFindingCommentBody(comment: OcrComment): string {
  const lines: string[] = [];
  appendFindingBody(lines, comment);
  return lines.join('\n').trim();
}

export interface GithubLineReviewComment {
  path: string;
  body: string;
  line: number;
  start_line?: number;
}

export interface GithubFileReviewComment {
  path: string;
  body: string;
}

export function partitionReviewComments(result: OcrReviewEnvelope): {
  lineComments: GithubLineReviewComment[];
  fileComments: GithubFileReviewComment[];
  unplacedComments: OcrComment[];
} {
  const comments = normalizeComments(result);
  const lineComments: GithubLineReviewComment[] = [];
  const fileComments: GithubFileReviewComment[] = [];
  const unplacedComments: OcrComment[] = [];

  for (const comment of comments) {
    const filePath = comment.path || comment.file;
    if (!filePath || filePath === 'unknown') {
      unplacedComments.push(comment);
      continue;
    }

    const body = formatFindingCommentBody(comment);
    if (!body) {
      continue;
    }

    const start = comment.start_line;
    const end = comment.end_line ?? start;

    if (typeof end === 'number' && end > 0) {
      const lineComment: GithubLineReviewComment = { path: filePath, body, line: end };
      if (typeof start === 'number' && start > 0 && start < end) {
        lineComment.start_line = start;
      }
      lineComments.push(lineComment);
    } else {
      fileComments.push({ path: filePath, body });
    }
  }

  return { lineComments, fileComments, unplacedComments };
}

function appendUnplacedFindings(lines: string[], comments: OcrComment[]): void {
  if (comments.length === 0) {
    return;
  }

  lines.push('', '### Findings without file location', '');
  for (const comment of comments.slice(0, 25)) {
    appendFinding(lines, comment);
  }
  if (comments.length > 25) {
    lines.push(`_…and ${comments.length - 25} more finding(s)._`, '');
  }
}

function formatRetryAttemptSummary(
  attempts: NonNullable<NonNullable<OcrReviewEnvelope['retry_report']>['requests']>[number]['attempts'],
): string {
  const attempt = attempts?.[0];
  if (!attempt) {
    return '—';
  }
  const parts = [attempt.error_class, attempt.failure_phase].filter(Boolean);
  if (typeof attempt.duration_to_headers_ms === 'number') {
    const seconds = Math.round(attempt.duration_to_headers_ms / 1000);
    parts.push(`${seconds}s`);
  }
  return parts.join(' · ') || '—';
}

function appendRetryRequestTable(lines: string[], result: OcrReviewEnvelope): void {
  const requests = result.retry_report?.requests || [];
  const failedRequests = requests.filter((request) => request.outcome === 'failed');
  if (failedRequests.length === 0) {
    return;
  }

  lines.push('', '#### Per-file LLM failures', '');
  lines.push('| File | Task | Outcome | Error |');
  lines.push('| --- | --- | --- | --- |');
  for (const request of failedRequests.slice(0, 30)) {
    const filePath = request.file_path ? `\`${request.file_path}\`` : '—';
    const taskType = request.task_type || '—';
    const outcome = request.outcome || '—';
    const error = formatRetryAttemptSummary(request.attempts).replace(/\|/g, '\\|');
    lines.push(`| ${filePath} | ${taskType} | ${outcome} | ${error} |`);
  }
  if (failedRequests.length > 30) {
    lines.push('', `_…and ${failedRequests.length - 30} more failed request(s)._`);
  }
}

function appendRetryReport(lines: string[], result: OcrReviewEnvelope): void {
  const retryReport = result.retry_report;
  if (!retryReport) {
    return;
  }

  const failedRequests = retryReport.failed_requests ?? 0;
  const retriedRequests = retryReport.retried_requests ?? 0;
  if (failedRequests === 0 && retriedRequests === 0) {
    return;
  }

  lines.push('', '### LLM retries', '');
  if (typeof retryReport.total_requests === 'number') {
    lines.push(`Requests: ${retryReport.total_requests}`);
  }
  if (failedRequests > 0) {
    lines.push(`Failed: ${failedRequests}`);
  }
  if (retriedRequests > 0) {
    lines.push(`Retried: ${retriedRequests} (${retryReport.total_retries ?? 0} retry attempt(s))`);
  }

  const errorClasses = new Map<string, number>();
  for (const request of retryReport.requests || []) {
    for (const attempt of request.attempts || []) {
      if (!attempt.error_class) continue;
      errorClasses.set(attempt.error_class, (errorClasses.get(attempt.error_class) || 0) + 1);
    }
  }
  if (errorClasses.size > 0) {
    lines.push(
      'Errors: ' +
        [...errorClasses.entries()]
          .map(([errorClass, count]) => `${errorClass} (${count})`)
          .join(', '),
    );
  }

  appendRetryRequestTable(lines, result);
}

function buildReviewMarkdownCore(
  result: OcrReviewEnvelope,
  options: { includeFindings: boolean },
): string {
  const lines: string[] = ['## Code Review', ''];

  const stats = getRunStats(result);
  const coverage = getCoverage(result);
  const comments = normalizeComments(result);
  const findingCount = stats?.comments ?? comments.length;
  const failedCount = coverage?.failed?.length ?? 0;
  const filesReviewed = stats?.files_reviewed ?? getReviewedFilePaths(result).length;

  lines.push(headlineFor(result, findingCount, filesReviewed, failedCount));

  const statParts: string[] = [];
  if (filesReviewed > 0) {
    statParts.push(`${filesReviewed} file${filesReviewed === 1 ? '' : 's'} reviewed`);
  }
  if (stats?.elapsed) {
    statParts.push(stats.elapsed);
  }
  if (statParts.length > 0) {
    lines.push('', statParts.join(' · '));
  }

  appendBranchRange(lines, result);
  appendCoverageSummary(lines, result);
  appendRunStats(lines, result);

  if (options.includeFindings && comments.length > 0) {
    lines.push('', '### Findings', '');

    for (const comment of comments.slice(0, 25)) {
      appendFinding(lines, comment);
    }

    if (comments.length > 25) {
      lines.push(`_…and ${comments.length - 25} more finding(s)._`, '');
    }
  }

  if (coverage?.failed && coverage.failed.length > 0) {
    lines.push('', '### Files that could not be reviewed', '');
    for (const item of coverage.failed.slice(0, 25)) {
      lines.push(formatFailedItem(item));
    }
    if (coverage.failed.length > 25) {
      lines.push('', `_…and ${coverage.failed.length - 25} more failed file(s)._`);
    }
  }

  if (result.warnings && result.warnings.length > 0) {
    lines.push('', '### Warnings', '');
    for (const warning of result.warnings) {
      const prefix = warning.path ? `\`${warning.path}\`: ` : '';
      lines.push(`- ${prefix}${warning.message || 'Review subtask failed'}`);
    }
  }

  appendToolCalls(lines, result);
  appendRetryReport(lines, result);

  const reviewedPaths = getReviewedFilePaths(result);
  if (reviewedPaths.length > 0) {
    lines.push('', '<details>', '<summary>Files reviewed successfully</summary>', '');
    for (const filePath of reviewedPaths) {
      lines.push(`- \`${filePath}\``);
    }
    lines.push('', '</details>');
  }

  const model = result.manifest?.execution?.model || result.llm?.model;
  const ocrVersion = result.manifest?.execution?.ocr_version;
  const footerParts = ['localagent-box'];
  if (ocrVersion) {
    footerParts.push(`OCR ${ocrVersion}`);
  }
  if (model) {
    footerParts.push(model);
  }
  if (result.session_id) {
    footerParts.push(`session ${result.session_id.slice(0, 8)}`);
  }

  lines.push('', `<sub>${footerParts.join(' · ')}</sub>`);

  return lines.join('\n').trim();
}

/** Full review markdown for local session UI (includes inline findings list). */
export function formatReviewMarkdown(result: OcrReviewEnvelope): string {
  return buildReviewMarkdownCore(result, { includeFindings: true });
}

/** Summary-only markdown for the GitHub PR review body (findings posted as file comments). */
export function formatReviewSummaryMarkdown(result: OcrReviewEnvelope): string {
  const { unplacedComments } = partitionReviewComments(result);
  const lines = buildReviewMarkdownCore(result, { includeFindings: false }).split('\n');
  if (unplacedComments.length > 0) {
    appendUnplacedFindings(lines, unplacedComments);
  }
  return lines.join('\n').trim();
}

export function formatReviewBackgroundMessage(options: {
  baseBranch?: string | null;
  headBranch?: string | null;
  background?: string | null;
}): string | null {
  const parts: string[] = [];
  if (options.baseBranch && options.headBranch) {
    parts.push(`Review branches \`${options.baseBranch}\` → \`${options.headBranch}\`.`);
  } else if (options.headBranch) {
    parts.push(`Review branch \`${options.headBranch}\`.`);
  }

  const background = options.background?.trim();
  if (background) {
    parts.push('', '**Review context**', '', background);
  }

  if (parts.length === 0) {
    return null;
  }

  return parts.join('\n').trim();
}

function formatSessionItemsTable(items: unknown): string[] {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  const lines = ['| File | Status |', '| --- | --- |'];
  for (const item of items.slice(0, 40)) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const filePath =
      typeof record.path === 'string'
        ? record.path
        : typeof record.file_path === 'string'
          ? record.file_path
          : '—';
    const status =
      typeof record.status === 'string'
        ? record.status
        : typeof record.state === 'string'
          ? record.state
          : typeof record.terminal_state === 'string'
            ? record.terminal_state
            : '—';
    lines.push(`| \`${filePath}\` | ${status} |`);
  }
  if (items.length > 40) {
    lines.push('', `_…and ${items.length - 40} more session item(s)._`);
  }
  return lines;
}

export function formatOcrSessionMarkdown(
  sessionId: string,
  session: Record<string, unknown> | null,
): string {
  const lines = ['### OCR session', '', `Session ID: \`${sessionId}\``];

  if (!session) {
    lines.push(
      '',
      '_Session checkpoint data is not available. It is captured when the review completes; older sessions may not have it._',
    );
    lines.push('', 'Inspect locally with:', '', '```bash', `ocr session show ${sessionId} --json`, '```');
    return lines.join('\n').trim();
  }

  const status =
    typeof session.status === 'string'
      ? session.status
      : typeof session.terminal_state === 'string'
        ? session.terminal_state
        : null;
  if (status) {
    lines.push('', `Status: **${status}**`);
  }

  const operation = typeof session.operation === 'string' ? session.operation : null;
  if (operation) {
    lines.push(`Operation: \`${operation}\``);
  }

  const items = session.items ?? session.files ?? session.coverage;
  const tableLines = formatSessionItemsTable(items);
  if (tableLines.length > 0) {
    lines.push('', '#### Per-file checkpoints', '', ...tableLines);
  }

  lines.push(
    '',
    '<details>',
    '<summary>Full session JSON</summary>',
    '',
    '```json',
    JSON.stringify(session, null, 2),
    '```',
    '',
    '</details>',
    '',
    'Resume a compatible review with:',
    '',
    '```bash',
    `ocr review --resume ${sessionId}`,
    '```',
  );

  return lines.join('\n').trim();
}

export function formatReviewRawJsonMarkdown(result: Record<string, unknown>): string {
  return [
    '<details>',
    '<summary>Raw OCR output</summary>',
    '',
    '```json',
    JSON.stringify(result, null, 2),
    '```',
    '',
    '</details>',
  ].join('\n');
}
