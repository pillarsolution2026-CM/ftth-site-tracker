import type {
  HTMLAttributes,
  TableHTMLAttributes,
  ThHTMLAttributes,
  TdHTMLAttributes,
} from 'react';

/** Horizontally scrollable table; headers align to the start edge (RTL aware). */
export function Table({ className = '', ...rest }: TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="overflow-x-auto rounded-md border border-(--color-border)">
      <table className={`w-full border-collapse text-start text-sm ${className}`} {...rest} />
    </div>
  );
}

export function Th({ className = '', ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope="col"
      className={`border-b border-(--color-border) px-3 py-2 text-start font-semibold whitespace-nowrap ${className}`}
      {...rest}
    />
  );
}

export function Td({ className = '', ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={`border-b border-(--color-border) px-3 py-2 align-top ${className}`} {...rest} />
  );
}

export function PageHeader({ className = '', ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`mb-4 flex flex-wrap items-center justify-between gap-3 ${className}`}
      {...rest}
    />
  );
}
