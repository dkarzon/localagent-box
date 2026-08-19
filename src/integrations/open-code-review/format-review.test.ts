import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatReviewMarkdown, formatOcrSessionMarkdown } from './format-review';
import type { OcrReviewEnvelope } from './types';

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
