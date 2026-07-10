export function parsePositiveInt(value: unknown, fallback: number): number {
  if (value == null || value === '') {
    return fallback;
  }
  const parsed = parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
