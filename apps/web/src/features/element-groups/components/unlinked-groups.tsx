'use client';

import type { ElementGroupsResponse } from '@ftth/shared';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';

/** Warning: main groups of contract lines that no element offers (the supervisor cannot reach them). */
export function UnlinkedGroups({ unlinked }: { unlinked: ElementGroupsResponse['unlinked'] }) {
  const { t } = useI18n();
  if (unlinked.length === 0) return null;
  return (
    <Notice kind="warning">
      <h2 className="text-base font-semibold">{t('elementGroups.unlinked.title')}</h2>
      <p className="my-1">{t('elementGroups.unlinked.body')}</p>
      <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0">
        {unlinked.map((entry) => (
          <li key={entry.main}>
            <span className="font-semibold">{entry.main}</span>{' '}
            <Ltr>{t('elementGroups.unlinked.lines', { count: entry.lineCount })}</Ltr>
          </li>
        ))}
      </ul>
    </Notice>
  );
}
