'use client';

import { Button } from '@/shared/ui/button';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import { useCorrectionsPanel } from '../hooks/use-corrections-panel';

/**
 * «تحديث الأخطاء» (ADR-047): floats at the bottom right of a draft's page and rebuilds the drawing
 * with the corrections saved so far, so the problems are checked again; the page moves to the new
 * draft. Unsaved edits of the canvas must be saved first.
 */
export function RefreshProblemsButton({
  unsaved,
  ...input
}: Parameters<typeof useCorrectionsPanel>[0] & { unsaved: number }) {
  const { t } = useI18n();
  const panel = useCorrectionsPanel(input);
  if (!input.canEdit) return null;
  const blocked = unsaved > 0;
  return (
    <div className="fixed bottom-4 right-4 z-40 flex max-w-xs flex-col items-end gap-2">
      {panel.error ? <Notice kind="error">{t(panel.error.key, panel.error.params)}</Notice> : null}
      {blocked ? (
        <p className="rounded bg-white px-2 py-1 text-sm text-black shadow" role="status">
          {t('design.edit.saveFirst')}
        </p>
      ) : null}
      <Button
        className="rounded-full px-5 shadow-lg"
        onClick={panel.rebuild}
        disabled={blocked || !panel.canRebuild}
        title={t('design.edit.refreshHint')}
      >
        <span aria-hidden="true">⟳ </span>
        {panel.rebuilding ? t('design.edit.refreshing') : t('design.edit.refresh')}
      </Button>
    </div>
  );
}
