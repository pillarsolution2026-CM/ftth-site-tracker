'use client';

import { Button } from '@/shared/ui/button';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';

interface GroupSummaryProps {
  count: number;
  draft: boolean;
  filtered: boolean;
  /** Present when the viewer can jump to the lines; the PM view only reads. */
  onToggleFilter?: (() => void) | undefined;
}

/** Error summary above the BOQ: how many priced lines have no group (ADR-048). */
export function GroupSummary({ count, draft, filtered, onToggleFilter }: GroupSummaryProps) {
  const { t } = useI18n();
  if (count <= 0) return null;
  return (
    <Notice kind="error" className="mb-3">
      <p className="font-semibold">{t('admin.contracts.groups.summary', { count })}</p>
      {draft ? <p className="mt-1">{t('admin.contracts.groups.draftNeeds')}</p> : null}
      {onToggleFilter ? (
        <Button variant="outline" className="mt-2" aria-pressed={filtered} onClick={onToggleFilter}>
          {filtered
            ? t('admin.contracts.groups.showAll')
            : t('admin.contracts.groups.showUngrouped')}
        </Button>
      ) : null}
    </Notice>
  );
}
