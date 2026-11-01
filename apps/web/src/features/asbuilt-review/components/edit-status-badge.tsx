'use client';

import type { AsBuiltEditStatus, AsBuiltExportStatus } from '@ftth/shared';
import { useI18n } from '@/shared/i18n/locale-provider';
import { EDIT_STATUS_PRESENTATION, EXPORT_STATUS_PRESENTATION } from '../model/review-model';

/** Icon + text (colour only reinforces), so status never depends on colour. */
export function EditStatusBadge({ status }: { status: AsBuiltEditStatus }) {
  const { t } = useI18n();
  const presentation = EDIT_STATUS_PRESENTATION[status];
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

export function ExportStatusBadge({ status }: { status: AsBuiltExportStatus }) {
  const { t } = useI18n();
  const presentation = EXPORT_STATUS_PRESENTATION[status];
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
