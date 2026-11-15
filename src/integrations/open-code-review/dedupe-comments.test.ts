import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dedupeOcrComments } from './dedupe-comments';
import type { OcrComment } from './types';

describe('dedupeOcrComments', () => {
  it('drops exact duplicates and keeps the first occurrence', () => {
    const first: OcrComment = {
      path: 'src/api.ts',
      content: 'Missing 20-item selection cap.',
      start_line: 10,
      end_line: 12,
      severity: 'high',
    };
    const duplicate: OcrComment = {
      path: 'src/api.ts',
      content: '  Missing 20-item   selection cap.  ',
      start_line: 10,
      end_line: 12,
      severity: 'low',
    };

    const kept = dedupeOcrComments([first, duplicate]);
    assert.equal(kept.length, 1);
    assert.equal(kept[0], first);
  });

  it('keeps near-duplicates on different lines or paths', () => {
    const comments: OcrComment[] = [
      { path: 'src/api.ts', content: 'Missing cap.', start_line: 10 },
      { path: 'src/api.ts', content: 'Missing cap.', start_line: 11 },
      { path: 'src/server.ts', content: 'Missing cap.', start_line: 10 },
      { path: 'src/api.ts', content: 'Missing cap. Slightly different wording.', start_line: 10 },
    ];

    assert.equal(dedupeOcrComments(comments).length, 4);
  });

  it('keeps the original order of first occurrences', () => {
    const a: OcrComment = { path: 'src/a.ts', content: 'First.', start_line: 1 };
    const b: OcrComment = { path: 'src/b.ts', content: 'Second.', start_line: 2 };
    const aDup: OcrComment = { path: 'src/a.ts', content: 'First.', start_line: 1 };
    const c: OcrComment = { path: 'src/c.ts', content: 'Third.', start_line: 3 };

    const kept = dedupeOcrComments([a, b, aDup, c]);
    assert.deepEqual(kept.map((comment) => comment.path), ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('treats the file field as the path and same-line spans as equal to single lines', () => {
    const a: OcrComment = { file: 'src/a.ts', content: 'Same issue.', start_line: 5 };
    const dup: OcrComment = { path: 'src/a.ts', content: 'Same issue.', start_line: 5, end_line: 5 };

    const kept = dedupeOcrComments([a, dup]);
    assert.equal(kept.length, 1);
    assert.equal(kept[0], a);
  });

  it('keeps same-text comments anchored to different end lines when start_line is absent', () => {
    const comments: OcrComment[] = [
      { path: 'src/a.ts', content: 'Same issue.', end_line: 10 },
      { path: 'src/a.ts', content: 'Same issue.', end_line: 12 },
    ];

    assert.equal(dedupeOcrComments(comments).length, 2);
  });

  it('does not throw on malformed comments with non-string fields', () => {
    const malformed = {
      path: 'src/a.ts',
      content: undefined as unknown as string,
      start_line: 1,
    } as OcrComment;
    const badPath = {
      path: 7 as unknown as string,
      content: 'Real content.',
      start_line: 2,
    } as OcrComment;
    const ok: OcrComment = { path: 'src/a.ts', content: 'Real content.', start_line: 3 };

    const kept = dedupeOcrComments([malformed, badPath, ok]);
    assert.equal(kept.length, 3);
  });
});
