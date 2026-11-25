'use client';

import { useI18n } from '@/shared/i18n/locale-provider';
import { useElementGroupsQuery } from '../api/queries';

/** Small warning badge (icon + count + text, never colour alone) on the admin nav link. */
export function UnlinkedNavBadge() {
  const { t } = useI18n();
  const count = useElementGroupsQuery().data?.unlinked.length ?? 0;
  if (count === 0) return null;
  const text = t('elementGroups.navWarning', { count });
  return (
    <span className="ms-2 rounded-full border border-(--status-inProgress) px-2 text-xs font-semibold">
      <span aria-hidden="true">▲ {count}</span>
      <span className="sr-only">{text}</span>
    </span>
  );
}
