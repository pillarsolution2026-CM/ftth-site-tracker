import type { HTMLAttributes } from 'react';

/** Codes, numbers, coordinates and file names stay left-to-right inside RTL text. */
export function Ltr({ className = '', ...rest }: HTMLAttributes<HTMLElement>) {
  return <bdi dir="ltr" className={`tabular-nums ${className}`} {...rest} />;
}
