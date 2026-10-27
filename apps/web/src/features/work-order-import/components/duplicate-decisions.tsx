'use client';

import type { WorkOrderImportPreviewResponse } from '@ftth/shared';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import type { DuplicateDecision } from '../model/import-wizard';

interface DuplicateDecisionsProps {
  duplicates: WorkOrderImportPreviewResponse['summary']['duplicateCodes'];
  decisions: Record<string, DuplicateDecision>;
  unresolved: string[];
  onDecide: (code: string, decision: DuplicateDecision) => void;
}

/** Each repeated code needs an explicit choice; duplicates are never merged. */
export function DuplicateDecisions({
  duplicates,
  decisions,
  unresolved,
  onDecide,
}: DuplicateDecisionsProps) {
  const { t } = useI18n();
  if (duplicates.length === 0) return null;
  return (
    <section aria-labelledby="dups-title" className="flex flex-col gap-3">
      <h2 id="dups-title" className="text-lg font-semibold">
        {t('import.duplicates.title')}
      </h2>
      <p>{t('import.duplicates.explain')}</p>
      {duplicates.map((duplicate) => {
        const isUnresolved = unresolved.includes(duplicate.code);
        const name = `dup-${duplicate.code}`;
        return (
          <fieldset key={duplicate.code} className="rounded-md border border-(--color-border) p-3">
            <legend className="px-1 font-semibold">
              <Ltr>{duplicate.code}</Ltr>
              {' — '}
              {t('import.duplicates.rows', { rows: duplicate.rowNumbers.join(', ') })}
            </legend>
            {isUnresolved ? (
              <Notice kind="warning" live={false} className="mb-2">
                {t('import.duplicates.needsDecision')}
              </Notice>
            ) : null}
            {(['exclude', 'keep'] as const).map((decision) => (
              <label
                key={decision}
                htmlFor={`${name}-${decision}`}
                className="flex min-h-11 cursor-pointer items-center gap-2"
              >
                <input
                  id={`${name}-${decision}`}
                  type="radio"
                  name={name}
                  className="size-5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)"
                  checked={decisions[duplicate.code] === decision}
                  onChange={() => onDecide(duplicate.code, decision)}
                />
                <span>{t(`import.duplicates.decisions.${decision}`)}</span>
              </label>
            ))}
          </fieldset>
        );
      })}
    </section>
  );
}
