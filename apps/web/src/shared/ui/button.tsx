import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'outline';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-(--color-brand) text-(--color-brandContrast) border-transparent',
  outline: 'bg-transparent text-(--color-brand) border-(--color-brand)',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

export function Button({
  variant = 'primary',
  className = '',
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={
        'inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border px-4 text-base font-semibold ' +
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus) ' +
        'disabled:cursor-not-allowed disabled:opacity-60 ' +
        `${VARIANTS[variant]} ${className}`
      }
      {...rest}
    />
  );
}
