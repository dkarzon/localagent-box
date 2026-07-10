import type { ReactNode, InputHTMLAttributes, TextareaHTMLAttributes, ButtonHTMLAttributes } from 'react';

interface FieldProps {
  label: string;
  children: ReactNode;
  className?: string;
  mono?: boolean;
}

export function Field({ label, children, className = '', mono = false }: FieldProps) {
  return (
    <label className={`grid gap-1.5 ${className}`.trim()}>
      <span className={`label-md text-on-surface-variant ${mono ? 'font-mono' : ''}`}>
        {label}
      </span>
      {children}
    </label>
  );
}

const inputClass =
  'w-full rounded border border-outline-variant bg-surface-lowest px-3 py-2.5 text-sm text-on-surface placeholder:text-muted/70 focus-ring';

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={inputClass} {...props} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={inputClass} {...props} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={inputClass} {...props} />;
}

export function CheckboxField({
  label,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="flex items-center gap-2.5 text-sm text-on-surface-variant">
      <input
        type="checkbox"
        className="size-4 rounded border-outline-variant bg-surface-lowest accent-primary"
        {...props}
      />
      {label}
    </label>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost';

export function Button({
  type = 'button',
  variant = 'secondary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  const variants: Record<ButtonVariant, string> = {
    primary:
      'border-transparent bg-primary text-on-primary font-medium hover:bg-primary/90 shadow-[0_4px_14px_rgba(66,0,147,0.15)]',
    secondary:
      'border border-primary bg-transparent text-primary hover:bg-surface-low',
    ghost:
      'border border-outline-variant bg-transparent text-on-surface-variant hover:border-primary hover:bg-surface-low',
  };

  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-2 rounded px-4 py-2.5 text-sm transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${variants[variant]} ${className}`.trim()}
      {...props}
    />
  );
}

export function FormActions({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`mt-4 flex flex-wrap gap-3 ${className}`.trim()}>{children}</div>;
}

export function FormGrid({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`grid gap-4 ${className}`.trim()}>{children}</div>;
}

export function FormRow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`grid gap-4 sm:grid-cols-2 ${className}`.trim()}>{children}</div>;
}
