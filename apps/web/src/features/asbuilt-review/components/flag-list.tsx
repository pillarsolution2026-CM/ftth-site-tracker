'use client';

import type { AsBuiltEditFlag } from '@ftth/shared';
import { useI18n } from '@/shared/i18n/locale-provider';
import { FLAG_EXPLANATION, FLAG_LABEL } from '../model/review-model';

/** Flags as icon + short text; with `explain` each one is also explained in words. */
export function FlagList({
  flags,
  explain = false,
}: {
  flags: AsBuiltEditFlag[];
  explain?: boolean;
}) {
  const { t } = useI18n();
  if (flags.length === 0) return <span>{t('asbuiltReview.noFlags')}</span>;
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {flags.map((flag) => (
        <li key={flag} data-flag={flag}>
          <span className="inline-flex items-center gap-1 font-medium">
            <span aria-hidden="true">▲</span>
            <span>{t(FLAG_LABEL[flag])}</span>
          </span>
          {explain ? <p className="m-0 text-sm">{t(FLAG_EXPLANATION[flag])}</p> : null}
        </li>
      ))}
    </ul>
  );
}
