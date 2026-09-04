import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatFindingCommentBody,
  formatReviewMarkdown,
  formatReviewSummaryMarkdown,
  formatOcrSessionMarkdown,
  partitionReviewComments,
} from './format-review';
import type { OcrComment, OcrReviewEnvelope } from './types';

describe('formatReviewMarkdown', () => {
  it('formats complete review output with no findings', () => {
    const sample: OcrReviewEnvelope = {
      status: 'complete',
      message: 'Review complete: 0 finding(s) across 4 selected item(s).',
      summary: {
        files_reviewed: 4,
        comments: 0,
        total_tokens: 97264,
        input_tokens: 91736,
        output_tokens: 5528,
        elapsed: '4m11s',
      },
      comments: [],
      manifest: {
        input: { requested_from: 'main', requested_head: 'feature/foo' },
        execution: { ocr_version: 'v1.9.4', model: 'llama3.2' },
        coverage: {
          completed: [
            { path: 'client/src/components/agents/AgentSessionInfo.tsx' },
            { path: 'client/src/pages/AgentSessionsPage.tsx' },
            { path: 'client/src/pages/AgentSessionPage.tsx' },
            { path: 'src/lib/agent-pull-request.ts' },
          ],
        },
      },
    };
    const markdown = formatReviewMarkdown(sample);

    assert.match(markdown, /^## Code Review/);
    assert.match(markdown, /No issues found/);
    assert.match(markdown, /Review complete: 0 finding\(s\) across 4 selected item\(s\)\./);
    assert.match(markdown, /4 files reviewed · 4m11s/);
    assert.match(markdown, /AgentSessionInfo\.tsx/);
    assert.match(markdown, /localagent-box · OCR v1\.9\.4/);
    assert.doesNotMatch(markdown, /\[object Object\]/);
    assert.doesNotMatch(markdown, /"status":/);
  });

  it('formats partial review output with failed files and retry report', () => {
    const sample: OcrReviewEnvelope = {
      status: 'partial',
      message: 'Review partially complete: 10 of 11 selected item(s) failed.',
      summary: { files_reviewed: 1, comments: 0 },
      manifest: {
        input: {
          requested_from: 'main',
          requested_head: 'typescript',
        },
        coverage: {
          selected: Array.from({ length: 11 }, (_, index) => ({ path: `src/file-${index}.ts` })),
          failed: [
            {
              path: 'GrowthTrackerTabHeaderBlock.tsx',
              classification: 'timeout',
              reason: 'file review exceeded its time limit',
            },
            ...Array.from({ length: 9 }, (_, index) => ({
              path: `src/failed-${index}.ts`,
              classification: 'timeout',
              reason: 'file review exceeded its time limit',
            })),
          ],
          completed: [{ path: 'utils/imageSource.d.ts' }],
        },
      },
      retry_report: {
        total_requests: 11,
        failed_requests: 11,
        requests: [
          {
            file_path: 'GlobalStyles.d.ts',
            task_type: 'main_task',
            outcome: 'failed',
            attempts: [{ error_class: 'timeout', failure_phase: 'headers' }],
          },
          ...Array.from({ length: 10 }, () => ({
            file_path: 'other.ts',
            task_type: 'main_task',
            outcome: 'failed',
            attempts: [{ error_class: 'timeout' }],
          })),
        ],
      },
    };
    const markdown = formatReviewMarkdown(sample);

    assert.match(markdown, /Review partially complete/);
    assert.match(markdown, /10 of 11 selected item\(s\) failed/);
    assert.match(markdown, /`main` → `typescript`/);
    assert.match(markdown, /\| Failed \| 10 \|/);
    assert.match(markdown, /Files that could not be reviewed/);
    assert.match(markdown, /timeout: file review exceeded its time limit/);
    assert.match(markdown, /GrowthTrackerTabHeaderBlock\.tsx/);
    assert.match(markdown, /LLM retries/);
    assert.match(markdown, /Failed: 11/);
    assert.match(markdown, /timeout \(11\)/);
    assert.match(markdown, /Per-file LLM failures/);
    assert.match(markdown, /`GlobalStyles\.d\.ts` \| main_task \| failed/);
    assert.match(markdown, /Files reviewed successfully/);
    assert.match(markdown, /utils\/imageSource\.d\.ts/);
    assert.doesNotMatch(markdown, /No issues found/);
  });

  it('formats findings with line ranges and suggestions', () => {
    const markdown = formatReviewMarkdown({
      status: 'complete',
      message: 'Review complete: 2 finding(s) across 3 selected item(s).',
      summary: {
        files_reviewed: 3,
        comments: 2,
        elapsed: '1m12s',
      },
      comments: [
        {
          path: 'src/foo.ts',
          content: 'Concurrent map access without a lock.',
          start_line: 42,
          end_line: 47,
          suggestion_code: 'mu.Lock(); defer mu.Unlock();',
        },
        {
          path: 'src/bar.ts',
          content: 'Missing null check before dereference.',
          start_line: 10,
        },
      ],
      manifest: {
        coverage: {
          completed: [{ path: 'src/foo.ts' }, { path: 'src/bar.ts' }, { path: 'src/baz.ts' }],
        },
        execution: { ocr_version: 'v1.9.4', model: 'llama3.2' },
      },
    });

    assert.match(markdown, /2 finding\(s\)/);
    assert.match(markdown, /`src\/foo\.ts:42-47`/);
    assert.match(markdown, /Concurrent map access without a lock\./);
    assert.match(markdown, /```suggestion/);
    assert.match(markdown, /mu\.Lock\(\); defer mu\.Unlock\(\);/);
    assert.match(markdown, /`src\/bar\.ts:10`/);
  });

  it('includes collapsible reasoning under findings', () => {
    const markdown = formatReviewMarkdown({
      status: 'complete',
      summary: { files_reviewed: 1, comments: 1 },
      comments: [
        {
          path: 'src/foo.ts',
          content: 'Potential race condition.',
          start_line: 10,
          thinking: 'The map is written without synchronization.',
        },
      ],
    });

    assert.match(markdown, /Potential race condition\./);
    assert.match(markdown, /<summary>Reasoning<\/summary>/);
    assert.match(markdown, /written without synchronization/);
  });

  it('formats OCR session markdown with resume hint', () => {
    const markdown = formatOcrSessionMarkdown('abcd-1234', {
      status: 'partial',
      operation: 'review',
      items: [{ path: 'src/foo.ts', status: 'complete' }],
    });

    assert.match(markdown, /Session ID: `abcd-1234`/);
    assert.match(markdown, /Per-file checkpoints/);
    assert.match(markdown, /`src\/foo\.ts`/);
    assert.match(markdown, /ocr review --resume abcd-1234/);
  });

  it('supports legacy string summary and issues array', () => {
    const markdown = formatReviewMarkdown({
      summary: 'Looks good overall.',
      issues: [{ file: 'src/legacy.ts', line: 5, message: 'Unused import.' }],
    });

    assert.match(markdown, /1 finding\(s\)/);
    assert.match(markdown, /`src\/legacy\.ts:5`/);
    assert.match(markdown, /Unused import\./);
  });

  it('supports legacy string summary with no issues', () => {
    const markdown = formatReviewMarkdown({
      summary: 'Looks good overall.',
    });

    assert.match(markdown, /Looks good overall\./);
    assert.match(markdown, /No issues found/);
  });
});

describe('formatReviewSummaryMarkdown', () => {
  it('omits inline findings when they have file paths', () => {
    const result: OcrReviewEnvelope = {
      status: 'complete',
      summary: { files_reviewed: 2, comments: 2 },
      comments: [
        { path: 'src/foo.ts', content: 'Issue one.', start_line: 10 },
        { path: 'src/bar.ts', content: 'Issue two.', start_line: 20 },
      ],
    };

    const summary = formatReviewSummaryMarkdown(result);
    assert.match(summary, /2 finding\(s\)/);
    assert.doesNotMatch(summary, /### Findings/);
    assert.doesNotMatch(summary, /Issue one\./);
    assert.doesNotMatch(summary, /Issue two\./);
  });

  it('keeps findings without file paths in the summary', () => {
    const summary = formatReviewSummaryMarkdown({
      status: 'complete',
      summary: { files_reviewed: 1, comments: 1 },
      comments: [{ content: 'General concern without a file path.' }],
    });

    assert.match(summary, /Findings without file location/);
    assert.match(summary, /General concern without a file path\./);
    const footerIndex = summary.indexOf('<sub>localagent-box');
    const findingsIndex = summary.indexOf('Findings without file location');
    assert.ok(findingsIndex >= 0 && footerIndex >= 0);
    assert.ok(findingsIndex < footerIndex);
  });
});

describe('partitionReviewComments', () => {
  it('splits line and file comments', () => {
    const partitioned = partitionReviewComments({
      comments: [
        {
          path: 'src/foo.ts',
          content: 'Line issue.',
          start_line: 42,
          end_line: 47,
        },
        {
          path: 'src/bar.ts',
          content: 'File issue.',
        },
        { content: 'No path.' },
      ],
    });

    assert.equal(partitioned.lineComments.length, 1);
    assert.equal(partitioned.lineComments[0].path, 'src/foo.ts');
    assert.equal(partitioned.lineComments[0].line, 47);
    assert.equal(partitioned.lineComments[0].start_line, 42);
    assert.equal(partitioned.lineComments[0].side, 'RIGHT');
    assert.equal(partitioned.lineComments[0].start_side, 'RIGHT');
    assert.match(partitioned.lineComments[0].body, /Line issue\./);

    assert.equal(partitioned.fileComments.length, 1);
    assert.equal(partitioned.fileComments[0].path, 'src/bar.ts');
    assert.equal(partitioned.fileComments[0].ordinal, 1);

    assert.equal(partitioned.unplacedComments.length, 1);
  });

  it('carries the source OCR ordinal on line comments for comment mapping', () => {
    const partitioned = partitionReviewComments({
      comments: [
        { content: 'No path.' },
        {
          path: 'src/foo.ts',
          content: 'Line issue.',
          start_line: 42,
          end_line: 47,
        },
      ],
    });

    assert.equal(partitioned.lineComments.length, 1);
    assert.equal(partitioned.lineComments[0].ordinal, 1);
  });
});

describe('formatFindingCommentBody', () => {
  it('includes suggestion blocks for GitHub review comments', () => {
    const body = formatFindingCommentBody({
      path: 'src/foo.ts',
      content: 'Use a lock.',
      suggestion_code: 'mu.Lock()',
    });

    assert.match(body, /Use a lock\./);
    assert.match(body, /```suggestion/);
    assert.match(body, /mu\.Lock\(\)/);
  });
});

describe('severity and category surfacing', () => {
  const sample: OcrReviewEnvelope = {
    status: 'complete',
    summary: { files_reviewed: 2, comments: 3 },
    comments: [
      {
        path: 'src/low.ts',
        content: 'Minor naming issue.',
        start_line: 5,
        severity: 'low',
        category: 'style',
      },
      {
        path: 'src/crit.ts',
        content: 'Command injection from untrusted input.',
        start_line: 12,
        severity: 'critical',
        category: 'security',
      },
      {
        path: 'src/med.ts',
        content: 'O(n²) loop over hot path.',
        start_line: 30,
        severity: 'medium',
        category: 'performance',
      },
    ],
  };

  it('shows severity and category badges in inline findings', () => {
    const markdown = formatReviewMarkdown(sample);

    assert.match(markdown, /🔴 \*\*critical\*\* · 🔒 Security/);
    assert.match(markdown, /🟡 \*\*medium\*\* · ⚡ Performance/);
    assert.match(markdown, /🔵 \*\*low\*\* · 🎨 Style/);
  });

  it('sorts findings by severity, critical first', () => {
    const markdown = formatReviewMarkdown(sample);
    const critIndex = markdown.indexOf('Command injection');
    const medIndex = markdown.indexOf('O(n²) loop');
    const lowIndex = markdown.indexOf('Minor naming issue.');

    assert.ok(critIndex >= 0 && medIndex >= 0 && lowIndex >= 0);
    assert.ok(critIndex < medIndex);
    assert.ok(medIndex < lowIndex);
  });

  it('includes a severity and category breakdown table', () => {
    const markdown = formatReviewMarkdown(sample);

    assert.match(markdown, /### Severity & categories/);
    assert.match(markdown, /\| 🔴 critical \| 1 \|/);
    assert.match(markdown, /\| 🟡 medium \| 1 \|/);
    assert.match(markdown, /\| 🔒 Security \| 1 \|/);
    assert.match(markdown, /\| ⚡ Performance \| 1 \|/);
    assert.match(markdown, /\| 🎨 Style \| 1 \|/);
  });

  it('includes the breakdown in the GitHub PR summary body', () => {
    const summary = formatReviewSummaryMarkdown(sample);

    assert.match(summary, /### Severity & categories/);
    assert.match(summary, /\| 🔴 critical \| 1 \|/);
    assert.match(summary, /\| 🔒 Security \| 1 \|/);
    assert.doesNotMatch(summary, /### Findings/);
  });

  it('includes severity and category badges in GitHub line comment bodies', () => {
    const { lineComments } = partitionReviewComments(sample);

    const critical = lineComments.find((comment) => comment.path === 'src/crit.ts');
    assert.ok(critical);
    assert.match(critical.body, /🔴 \*\*critical\*\* · 🔒 Security/);

    const low = lineComments.find((comment) => comment.path === 'src/low.ts');
    assert.ok(low);
    assert.match(low.body, /🔵 \*\*low\*\* · 🎨 Style/);
  });

  it('keeps findings without severity or category rendering cleanly', () => {
    const markdown = formatReviewMarkdown({
      status: 'complete',
      summary: { files_reviewed: 1, comments: 1 },
      comments: [{ path: 'src/plain.ts', content: 'No metadata attached.', start_line: 3 }],
    } as OcrReviewEnvelope);

    assert.match(markdown, /No metadata attached\./);
    assert.doesNotMatch(markdown, /Severity & categories/);
  });

  it('ignores unknown severity and category values', () => {
    const comments: OcrComment[] = [
      {
        path: 'src/x.ts',
        content: 'Odd metadata.',
        severity: 'blocker',
        category: 'weirdness',
      },
    ];
    const body = formatFindingCommentBody(comments[0]);

    assert.equal(body, 'Odd metadata.');
  });

  it('headline includes severity counts when no message is present', () => {
    const markdown = formatReviewMarkdown({
      status: 'complete',
      summary: { files_reviewed: 2, comments: 3 },
      comments: sample.comments,
    } as OcrReviewEnvelope);

    assert.match(markdown, /🔍 \*\*3 finding\(s\)\*\* across 2 file\(s\) — critical: 1, medium: 1, low: 1\./);
  });

  it('headline appends other bucket when severity counts do not sum to finding count', () => {
    const markdown = formatReviewMarkdown({
      status: 'complete',
      summary: { files_reviewed: 2, comments: 3 },
      comments: [
        { path: 'src/crit.ts', content: 'Critical issue.', severity: 'critical' },
        { path: 'src/plain.ts', content: 'No metadata attached.' },
      ],
    } as OcrReviewEnvelope);

    assert.match(
      markdown,
      /🔍 \*\*3 finding\(s\)\*\* across 2 file\(s\) — critical: 1, other: 2\./,
    );
  });
});
