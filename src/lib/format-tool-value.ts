const DEFAULT_MAX_LEN = 4000;

export function formatToolValue(value: unknown, maxLen = DEFAULT_MAX_LEN): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  if (text.length <= maxLen) {
    return text;
  }
  return `${text.slice(0, maxLen)}\n… (truncated)`;
}
