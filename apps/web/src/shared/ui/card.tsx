import type { HTMLAttributes } from 'react';

export function Card({ className = '', ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-lg border border-(--color-border) bg-(--color-surface) p-6 text-(--color-text) shadow-sm ${className}`}
      {...rest}
    />
  );
}
