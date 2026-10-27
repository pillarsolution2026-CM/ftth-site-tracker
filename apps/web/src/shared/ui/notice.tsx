import type { ReactNode } from 'react';

type Kind = 'error' | 'warning' | 'info' | 'success';

const STYLE: Record<Kind, { icon: string; border: string }> = {
  error: { icon: '⚠', border: 'border-(--status-rejected)' },
  warning: { icon: '▲', border: 'border-(--status-inProgress)' },
  info: { icon: 'ℹ', border: 'border-(--status-executed)' },
  success: { icon: '✓', border: 'border-(--status-approved)' },
};

interface NoticeProps {
  kind: Kind;
  children: ReactNode;
  className?: string;
  /** Errors interrupt screen readers; the rest are polite. */
  live?: boolean;
}

/** Message with an icon and a start border: the kind is never carried by colour alone. */
export function Notice({ kind, children, className = '', live = true }: NoticeProps) {
  const { icon, border } = STYLE[kind];
  return (
    <div
      role={live ? (kind === 'error' ? 'alert' : 'status') : undefined}
      className={`flex items-start gap-2 rounded-md border border-s-4 border-(--color-border) ${border} px-3 py-2 text-sm ${className}`}
    >
      <span aria-hidden="true">{icon}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
