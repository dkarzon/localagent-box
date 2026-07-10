import type { StatusVariant } from '../../api/types';

const variantClasses: Record<StatusVariant, string> = {
  '': 'text-muted',
  success: 'text-success',
  error: 'text-error',
};

interface StatusMessageProps {
  message: string;
  variant?: StatusVariant;
  className?: string;
  mono?: boolean;
}

export function StatusMessage({
  message,
  variant = '',
  className = '',
  mono = false,
}: StatusMessageProps) {
  if (!message) {
    return null;
  }

  return (
    <p
      className={`text-sm ${variantClasses[variant]} ${mono ? 'code-md text-xs' : ''} ${className}`.trim()}
      aria-live="polite"
    >
      {message}
    </p>
  );
}
