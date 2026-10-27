import type { InputHTMLAttributes } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  id: string;
  label: string;
  /** Already translated message; shown with text and an icon, never by colour alone. */
  error?: string | undefined;
}

/** Label + input + error message wired together for assistive tech. */
export function Input({ id, label, error, className = '', ...rest }: InputProps) {
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={
          'min-h-11 rounded-md border border-(--color-border) bg-transparent px-3 text-base ' +
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus) ' +
          (error ? 'border-2 border-(--status-rejected) ' : '') +
          className
        }
        {...rest}
      />
      {error ? (
        <p id={errorId} className="flex items-center gap-1 text-sm text-(--status-rejected)">
          <span aria-hidden="true">⚠</span>
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
