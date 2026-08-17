import type { OcrComment, OcrReviewEnvelope } from './types';

function normalizeComments(result: OcrReviewEnvelope): OcrComment[] {
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

function getReviewedFilePaths(result: OcrReviewEnvelope): string[] {
  const coverage = result.manifest?.coverage;
  const fromCoverage = (coverage?.completed || coverage?.selected || [])
    .map((item) => item.path)
    .filter((path): path is string => Boolean(path));

  if (fromCoverage.length > 0) {
    return [...new Set(fromCoverage)];
  }

  return [...new Set(normalizeComments(result).map((comment) => comment.path || comment.file).filter(Boolean) as string[])];
}

function getRunStats(result: OcrReviewEnvelope) {
  if (typeof result.summary === 'object' && result.summary) {
    return result.summary;
  }
  return null;
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

function headlineFor(result: OcrReviewEnvelope, findingCount: number, filesReviewed: number): string {
  const message = result.message?.trim();
  const legacySummary = typeof result.summary === 'string' ? result.summary.trim() : '';

  if (result.status === 'skipped') {
    return `⚠️ **Skipped** — ${message || legacySummary || 'No files eligible for review.'}`;
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

export function formatReviewMarkdown(result: OcrReviewEnvelope): string {
  const lines: string[] = ['## Code Review', ''];

  const stats = getRunStats(result);
  const comments = normalizeComments(result);
  const findingCount = stats?.comments ?? comments.length;
  const filesReviewed = stats?.files_reviewed ?? getReviewedFilePaths(result).length;

  lines.push(headlineFor(result, findingCount, filesReviewed));

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

  if (comments.length > 0) {
    lines.push('', '### Findings', '');

    for (const comment of comments.slice(0, 25)) {
      lines.push(`#### ${formatLocation(comment)}`, '', comment.content.trim());

      if (comment.suggestion_code?.trim()) {
        lines.push('', '**Suggestion:**', '```suggestion', comment.suggestion_code.trim(), '```');
      } else if (comment.existing_code?.trim()) {
        lines.push('', '**Referenced code:**', '```', comment.existing_code.trim(), '```');
      }

      lines.push('');
    }

    if (comments.length > 25) {
      lines.push(`_…and ${comments.length - 25} more finding(s)._`, '');
    }
  }

  if (result.warnings && result.warnings.length > 0) {
    lines.push('', '### Warnings', '');
    for (const warning of result.warnings) {
      const prefix = warning.path ? `\`${warning.path}\`: ` : '';
      lines.push(`- ${prefix}${warning.message || 'Review subtask failed'}`);
    }
  }

  const reviewedPaths = getReviewedFilePaths(result);
  if (reviewedPaths.length > 0) {
    lines.push('', '<details>', '<summary>Files reviewed</summary>', '');
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

  lines.push('', `<sub>${footerParts.join(' · ')}</sub>`);

  return lines.join('\n').trim();
}
