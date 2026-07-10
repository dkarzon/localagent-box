import type { ReactNode } from 'react';

interface CardProps {
  title?: string;
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  padding?: 'sm' | 'md' | 'lg';
}

const paddingMap = {
  sm: 'p-4',
  md: 'p-6',
  lg: 'p-6',
};

export function Card({ title, icon, action, children, className = '', padding = 'md' }: CardProps) {
  return (
    <section className={`card-surface ${paddingMap[padding]} ${className}`.trim()}>
      {title ? (
        <header className="mb-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            {icon ? <span className="text-on-surface-variant">{icon}</span> : null}
            <h2 className="headline-md text-on-surface">{title}</h2>
          </div>
          {action}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function SectionCard({
  title,
  icon,
  action,
  children,
  className = '',
}: Omit<CardProps, 'padding'>) {
  return (
    <div className={`card-surface overflow-hidden ${className}`.trim()}>
      <header className="card-header-rule flex items-center justify-between gap-4 px-6 py-4">
        <div className="flex items-center gap-2">
          {icon ? <span className="text-on-surface-variant">{icon}</span> : null}
          <h3 className="text-base font-medium text-on-surface">{title}</h3>
        </div>
        {action}
      </header>
      <div className="p-6">{children}</div>
    </div>
  );
}

export function StatCard({
  label,
  value,
  meta,
  accent = false,
  className = '',
}: {
  label: string;
  value: ReactNode;
  meta?: ReactNode;
  accent?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`flex h-32 flex-col justify-between rounded-lg border p-6 ${
        accent
          ? 'border-primary bg-primary text-on-primary'
          : 'border-surface-container-highest bg-surface-lowest'
      } ${className}`.trim()}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className={`label-md ${accent ? 'text-on-primary/80' : 'text-on-surface-variant'}`}
        >
          {label}
        </span>
        {meta}
      </div>
      <p className={`text-2xl font-semibold ${accent ? 'text-on-primary' : 'text-on-surface'}`}>
        {value}
      </p>
    </div>
  );
}
