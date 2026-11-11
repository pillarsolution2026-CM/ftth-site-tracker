'use client';

import type { DrawingKind } from '@ftth/shared';
import { useI18n } from '@/shared/i18n/locale-provider';

/** «رئيسي» / «ثانوي» (ADR-040): a word and a mark, never colour alone. */
export function DrawingKindBadge({ kind }: { kind: DrawingKind }) {
  const { t } = useI18n();
  return (
    <span
      data-kind={kind}
      className="inline-flex items-center gap-1 rounded-md border border-(--color-border) px-2 py-0.5 text-sm font-semibold"
    >
      <span aria-hidden="true">{kind === 'general' ? '◆' : '◇'}</span>
      {t(`drawingKind.badge.${kind}`)}
    </span>
  );
}
