'use client';

import type { ContractStatus } from '@ftth/shared';
import { useI18n } from '@/shared/i18n/locale-provider';

const STYLE: Record<ContractStatus, { icon: string; border: string }> = {
  draft: { icon: '✎', border: 'border-(--status-inProgress)' },
  approved: { icon: '✓', border: 'border-(--status-approved)' },
};

/** Status as text plus an icon, never by colour alone. */
export function ContractStatusBadge({ status }: { status: ContractStatus }) {
  const { t } = useI18n();
  const { icon, border } = STYLE[status];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border-2 px-2 py-0.5 text-sm font-medium ${border}`}
    >
      <span aria-hidden="true">{icon}</span>
      {t(`admin.contracts.statuses.${status}`)}
    </span>
  );
}
