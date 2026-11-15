import type { OcrComment } from './types';

/** Identity key for exact-duplicate detection: path, lines, content, and the suggested fix. */
function duplicateKey(comment: OcrComment): string {
  const pathPart = comment.path || comment.file;
  const path = typeof pathPart === 'string' ? pathPart.trim() : '';
  const start = typeof comment.start_line === 'number' ? comment.start_line : '';
  const rawEnd = comment.end_line ?? comment.start_line;
  const end = typeof rawEnd === 'number' ? rawEnd : '';
  const rawContent = typeof comment.content === 'string' ? comment.content : '';
  const content = rawContent.trim().replace(/\s+/g, ' ');
  const suggestion = typeof comment.suggestion_code === 'string' ? comment.suggestion_code.trim() : '';
  return `${path}\u0000${start}\u0000${end}\u0000${content}\u0000${suggestion}`;
}

/**
 * Drops exact duplicate OCR comments: same path, same start/end line, same
 * content after trimming and collapsing whitespace, and the same suggested fix
 * (so comments proposing different fixes on the same span are kept). Keeps the
 * first occurrence and the original order. No fuzzy or semantic matching.
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
