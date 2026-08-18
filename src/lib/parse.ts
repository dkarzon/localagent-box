export function parsePositiveInt(value: unknown, fallback: number): number {
  if (value == null || value === '') {
    return fallback;
  }
  const parsed = parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Like parsePositiveInt, but `0` is a valid value (e.g. disable a timeout). */
export function parseNonNegativeInt(value: unknown, fallback: number): number {
  if (value == null || value === '') {
    return fallback;
  }
  const parsed = parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
