export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  const digits = value >= 100 || exponent === 0 ? 0 : value >= 10 ? 1 : 2;

  return `${value.toFixed(digits)} ${units[exponent]}`;
}

export function formatModelUpdated(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';

  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Updated just now';
  if (mins < 60) return `Updated ${mins}m ago`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Updated ${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `Updated ${days}d ago`;

  return `Updated ${date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })}`;
}

export function formatRelativeTime(iso?: string): string {
  if (!iso) return 'unknown';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatTokenCount(n: number): string {
  const formatScaled = (value: number, suffix: 'k' | 'M'): string =>
    `${value % 1 === 0 ? value.toFixed(0) : value.toFixed(1)}${suffix}`;

  if (n >= 1_000_000) return formatScaled(n / 1_000_000, 'M');
  if (n >= 1_000) {
    const thousands = Number((n / 1_000).toFixed(1));
    return thousands >= 1_000 ? formatScaled(n / 1_000_000, 'M') : formatScaled(thousands, 'k');
  }
  return String(n);
}

export function formatCost(cost: number): string {
  if (cost === 0) return '$0.00';
  if (cost < 0.0001) return `$${cost.toExponential(2)}`;
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

export function formatDuration(start?: string, end?: string): string {
  if (!start) return '—';
  const startMs = new Date(start).getTime();
  const endMs = end ? new Date(end).getTime() : Date.now();
  const diff = Math.max(0, endMs - startMs);
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  const secs = Math.floor((diff % 60000) / 1000);
  if (hours > 0) return `${hours}h ${remMins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}
