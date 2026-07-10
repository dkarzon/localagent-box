import type { ReactNode } from 'react';

type BadgeVariant =
  | 'running'
  | 'completed'
  | 'queued'
  | 'failed'
  | 'verified'
  | 'idle'
  | 'error'
  | 'neutral'
  | 'awaiting'
  | 'processing'
  | 'completing';

const variantStyles: Record<BadgeVariant, string> = {
  running: 'border-success/30 bg-success-container text-on-success-container',
  completed: 'border-surface-container-highest bg-surface-container text-on-surface-variant',
  queued: 'border-primary/30 bg-primary/10 text-primary',
  failed: 'border-error/30 bg-error-container text-on-error-container',
  verified: 'border-success/30 bg-success-container text-on-success-container',
  idle: 'border-surface-container-highest bg-surface-container text-muted',
  error: 'border-error/30 bg-error-container text-on-error-container',
  neutral: 'border-surface-container-highest bg-surface-container text-on-surface-variant',
  awaiting: 'border-primary/40 bg-primary/15 text-primary',
  processing: 'border-success/30 bg-success-container text-on-success-container',
  completing: 'border-primary/30 bg-primary-container text-on-primary-container',
};

interface BadgeProps {
  variant?: BadgeVariant;
  children: ReactNode;
  pulse?: boolean;
  className?: string;
}

export function Badge({ variant = 'neutral', children, pulse, className = '' }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 label-md normal-case tracking-wide ${variantStyles[variant]} ${className}`.trim()}
    >
      {pulse ? <span className="size-1.5 rounded-full bg-current pulse-dot" /> : null}
      {children}
    </span>
  );
}

export function agentStatusVariant(status: string): BadgeVariant {
  switch (status) {
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'queued':
      return 'queued';
    case 'awaiting_input':
      return 'awaiting';
    case 'processing':
      return 'processing';
    case 'completing':
      return 'completing';
    case 'failed':
    case 'cancelled':
      return 'failed';
    default:
      return 'neutral';
  }
}

export function agentStatusPulse(status: string): boolean {
  return (
    status === 'running' ||
    status === 'queued' ||
    status === 'processing' ||
    status === 'completing'
  );
}

export function repoStatusVariant(status?: string): BadgeVariant {
  if (!status) return 'idle';
  if (status === 'ok' || status === 'verified') return 'verified';
  if (status === 'failed' || status === 'clone_failed') return 'error';
  return 'idle';
}
