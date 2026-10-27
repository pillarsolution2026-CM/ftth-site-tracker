'use client';

import { useI18n } from '@/shared/i18n/locale-provider';
import { formatDecimal } from '@/shared/lib/decimal';
import { Ltr } from '@/shared/ui/ltr';
import type { Selection } from '../model/import-wizard';

/** Rows total / included / with errors / with warnings and the exact total of the included rows. */
export function ImportSummary({ selection }: { selection: Selection }) {
  const { t, locale } = useI18n();
  const stats: [string, string | number][] = [
    [t('import.summary.total'), selection.counts.total],
    [t('import.summary.included'), selection.counts.included],
    [t('import.summary.errors'), selection.counts.errorRows],
    [t('import.summary.warnings'), selection.counts.warningRows],
  ];
  return (
    <section aria-labelledby="import-summary-title">
      <h2 id="import-summary-title" className="mb-2 text-lg font-semibold">
        {t('import.summary.title')}
      </h2>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {stats.map(([label, value]) => (
          <div key={label} className="rounded-md border border-(--color-border) p-3">
            <dt className="text-sm opacity-80">{label}</dt>
            <dd className="text-xl font-semibold">
              <Ltr>{value}</Ltr>
            </dd>
          </div>
        ))}
        <div className="rounded-md border border-(--color-border) p-3">
          <dt className="text-sm opacity-80">{t('import.summary.computedTotal')}</dt>
          <dd className="text-xl font-semibold" data-testid="import-total">
            <Ltr>{formatDecimal(selection.total, locale, { minFractionDigits: 2 })}</Ltr>
          </dd>
        </div>
      </dl>
    </section>
  );
}
