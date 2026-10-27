import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

const CONTROL =
  'min-h-11 rounded-md border border-(--color-border) bg-transparent px-3 text-base ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)';

interface FieldShellProps {
  id: string;
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
  children: ReactNode;
}

function FieldShell({ id, label, error, hint, children }: FieldShellProps) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && !error ? (
        <p id={`${id}-hint`} className="text-sm opacity-80">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="flex items-center gap-1 text-sm text-(--status-rejected)">
          <span aria-hidden="true">⚠</span>
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}

function describedBy(id: string, error?: string, hint?: string): string | undefined {
  if (error) return `${id}-error`;
  return hint ? `${id}-hint` : undefined;
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  id: string;
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
}

export function Select({ id, label, error, hint, className = '', children, ...rest }: SelectProps) {
  return (
    <FieldShell id={id} label={label} error={error} hint={hint}>
      <select
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, error, hint)}
        className={`${CONTROL} ${className}`}
        {...rest}
      >
        {children}
      </select>
    </FieldShell>
  );
}

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  id: string;
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
}

export function Textarea({ id, label, error, hint, className = '', ...rest }: TextareaProps) {
  return (
    <FieldShell id={id} label={label} error={error} hint={hint}>
      <textarea
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, error, hint)}
        className={`${CONTROL} py-2 ${className}`}
        {...rest}
      />
    </FieldShell>
  );
}

interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  id: string;
  label: string;
}

/** 44px tall hit area; the label is part of the click target. */
export function Checkbox({ id, label, className = '', ...rest }: CheckboxProps) {
  return (
    <label
      htmlFor={id}
      className={`inline-flex min-h-11 cursor-pointer items-center gap-2 ${className}`}
    >
      <input
        id={id}
        type="checkbox"
        className="size-5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)"
        {...rest}
      />
      <span>{label}</span>
    </label>
  );
}
