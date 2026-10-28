'use client';

import type { DesignRevisionStatus } from '@ftth/shared';
import { useI18n } from '@/shared/i18n/locale-provider';
import { REVISION_STATUS_PRESENTATION } from '../model/revision-status';

/** Icon + text (colour only reinforces), so status never depends on colour. */
export function RevisionStatusBadge({ status }: { status: DesignRevisionStatus }) {
  const { t } = useI18n();
  const presentation = REVISION_STATUS_PRESENTATION[status];
  return (
    <span
      data-status={status}
      className={`inline-flex min-h-8 items-center gap-1 rounded-md border-2 px-2 text-sm font-medium ${presentation.className}`}
    >
      <span aria-hidden="true">{presentation.icon}</span>
      <span>{t(presentation.labelKey)}</span>
    </span>
  );
}
