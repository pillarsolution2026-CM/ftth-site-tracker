'use client';

import type { CadFileStatus } from '@ftth/shared';
import { useI18n } from '@/shared/i18n/locale-provider';
import { STATUS_PRESENTATION } from '../model/cad-status';

/** Icon + text (colour only reinforces), so status never depends on colour. */
export function CadStatusBadge({ status }: { status: CadFileStatus }) {
  const { t } = useI18n();
  const presentation = STATUS_PRESENTATION[status];
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
