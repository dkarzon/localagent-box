export interface AnsiSegment {
  text: string;
  bold?: boolean;
  dim?: boolean;
  error?: boolean;
}

interface AnsiState {
  bold: boolean;
  dim: boolean;
  error: boolean;
}

const STRIP_PATTERN = new RegExp(
  [
    '[\\u001B\\u009B][[\\]()#;?]*',
    '(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?',
    '[0-9A-ORZcf-nqry=><]',
  ].join(''),
  'g',
);

/** Remove terminal control sequences so plain-text log views stay readable. */
export function stripAnsi(text: string): string {
  return text.replace(STRIP_PATTERN, '');
}

function emptyState(): AnsiState {
  return { bold: false, dim: false, error: false };
}

function applySgrCodes(codes: number[], state: AnsiState): void {
  for (const code of codes) {
    if (Number.isNaN(code)) continue;

    switch (code) {
      case 0:
        Object.assign(state, emptyState());
        break;
      case 1:
        state.bold = true;
        break;
      case 2:
        state.dim = true;
        break;
      case 22:
        state.bold = false;
        state.dim = false;
        break;
      case 39:
        state.error = false;
        break;
      case 90:
        state.dim = true;
        break;
      case 91:
        state.error = true;
        break;
      default:
        break;
    }
  }
}

function parseSgrBody(body: string): number[] {
  if (!body) return [0];
  return body.split(';').map((part) => parseInt(part, 10));
}

function segmentFromState(text: string, state: AnsiState): AnsiSegment {
  return {
    text,
    bold: state.bold || undefined,
    dim: state.dim || undefined,
    error: state.error || undefined,
  };
}

/** Parse SGR ANSI codes into styled spans for the log viewer. */
export function parseAnsi(text: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  const state = emptyState();
  let buffer = '';
  let index = 0;

  const flush = () => {
    if (!buffer) return;
    segments.push(segmentFromState(buffer, state));
    buffer = '';
  };

  while (index < text.length) {
    const code = text.charCodeAt(index);

    if (code === 0x1b) {
      if (text[index + 1] === '[') {
        const end = text.indexOf('m', index + 2);
        if (end === -1) {
          buffer += text[index];
          index += 1;
          continue;
        }

        flush();
        applySgrCodes(parseSgrBody(text.slice(index + 2, end)), state);
        index = end + 1;
        continue;
      }

      index += 1;
      continue;
    }

    if (code === 0x9b) {
      const end = text.indexOf('m', index + 1);
      if (end === -1) {
        index += 1;
        continue;
      }

      flush();
      applySgrCodes(parseSgrBody(text.slice(index + 1, end)), state);
      index = end + 1;
      continue;
    }

    buffer += text[index];
    index += 1;
  }

  flush();
  return segments.length > 0 ? segments : [{ text }];
}
