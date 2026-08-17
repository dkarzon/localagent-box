import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { formatReviewMarkdown } from './format-review';
import type { OcrReviewEnvelope } from './types';

describe('formatReviewMarkdown', () => {
  it('formats the real OCR sample with no findings', () => {
    const samplePath = path.join(process.cwd(), 'docs', 'code-review-sample.json');
    const sample = JSON.parse(fs.readFileSync(samplePath, 'utf8')) as OcrReviewEnvelope;
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
