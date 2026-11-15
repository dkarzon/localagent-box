import type { OcrComment } from './types';

/** Identity key for exact-duplicate detection: path, lines, and whitespace-normalized content. */
function duplicateKey(comment: OcrComment): string {
  const path = (comment.path || comment.file || '').trim();
  const start = typeof comment.start_line === 'number' ? comment.start_line : '';
  const end = typeof comment.end_line === 'number' ? comment.end_line : start;
  const content = comment.content.trim().replace(/\s+/g, ' ');
  return `${path}\u0000${start}\u0000${end}\u0000${content}`;
}

/**
 * Drops exact duplicate OCR comments: same path, same start/end line, and
 * same content after trimming and collapsing whitespace. Keeps the first
 * occurrence and the original order. No fuzzy or semantic matching.
 */
export function dedupeOcrComments(comments: OcrComment[]): OcrComment[] {
  const seen = new Set<string>();
  const kept: OcrComment[] = [];
  for (const comment of comments) {
    const key = duplicateKey(comment);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    kept.push(comment);
  }
  return kept;
}
