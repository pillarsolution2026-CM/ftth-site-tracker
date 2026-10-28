'use client';

import {
  DIFF_CHANGES,
  FEATURE_TYPES,
  TEXT_LINK_STATUSES,
  type DesignRevisionDetail,
} from '@ftth/shared';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import { formatDateTime } from '@/shared/lib/format';
import { formatDecimal } from '@/shared/lib/decimal';

function CountGrid({ title, rows }: { title: string; rows: [string, React.ReactNode][] }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h3 className="font-semibold">{title}</h3>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {rows.map(([label, value]) => (
          <div key={label} className="rounded-md border border-(--color-border) p-3">
            <dt className="text-sm opacity-80">{label}</dt>
            <dd className="text-xl font-semibold">
              <Ltr>{value}</Ltr>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Frozen inputs (CRS, unit, factor with the units-conflict warning) and the build's counts. */
export function RevisionSummary({ revision }: { revision: DesignRevisionDetail }) {
  const { t, locale } = useI18n();
  const facts: [string, React.ReactNode][] = [
    [t('design.crs'), <Ltr key="crs">{revision.crsEpsg}</Ltr>],
    [t('design.unit'), <Ltr key="unit">{revision.drawingUnit}</Ltr>],
    [t('design.factor'), <Ltr key="factor">{revision.metresPerUnit}</Ltr>],
    [t('design.insUnits'), <Ltr key="ins">{revision.insUnits ?? '—'}</Ltr>],
    [
      t('design.file'),
      <Ltr key="file" className="break-all">
        {revision.cadFileName}
      </Ltr>,
    ],
    [
      t('design.base'),
      revision.baseRevisionId === null ? t('design.baseNone') : t('design.baseRev'),
    ],
    [t('design.createdAt'), <Ltr key="created">{formatDateTime(revision.createdAt, locale)}</Ltr>],
    [
      t('design.builtAt'),
      <Ltr key="built">{revision.builtAt ? formatDateTime(revision.builtAt, locale) : '—'}</Ltr>,
    ],
    [
      t('design.publishedAt'),
      <Ltr key="published">
        {revision.publishedAt ? formatDateTime(revision.publishedAt, locale) : '—'}
      </Ltr>,
    ],
  ];
  return (
    <div className="flex flex-col gap-6">
      {revision.unitsConflict ? (
        <Notice kind="warning">{t('design.unitsConflict', { unit: revision.drawingUnit })}</Notice>
      ) : null}
      {revision.status === 'failed' ? (
        <Notice kind="error">
          <p className="font-semibold">
            {revision.errorCode
              ? t(`design.failure.${revision.errorCode}`)
              : t('design.status.failed')}
          </p>
          {revision.errorMessage ? (
            <Ltr className="mt-1 block font-mono text-xs break-all">{revision.errorMessage}</Ltr>
          ) : null}
        </Notice>
      ) : null}
      <dl className="grid gap-3 sm:grid-cols-3">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt className="text-sm opacity-80">{label}</dt>
            <dd className="font-medium">{value}</dd>
          </div>
        ))}
      </dl>
      {revision.counts ? (
        <CountGrid
          title={t('design.counts.title')}
          rows={[
            ...FEATURE_TYPES.map((type): [string, React.ReactNode] => [
              t(`featureType.${type}`),
              revision.counts?.features[type] ?? 0,
            ]),
            [t('design.counts.routeLength'), formatDecimal(revision.counts.routeLengthM, 'en')],
          ]}
        />
      ) : null}
      {revision.textLinkCounts ? (
        <CountGrid
          title={t('design.linkCounts.title')}
          rows={TEXT_LINK_STATUSES.map((status): [string, React.ReactNode] => [
            t(`design.linkStatus.${status}`),
            revision.textLinkCounts?.[status] ?? 0,
          ])}
        />
      ) : null}
      {revision.diffCounts ? (
        <CountGrid
          title={t('design.diffCounts.title')}
          rows={DIFF_CHANGES.map((change): [string, React.ReactNode] => [
            t(`design.change.${change}`),
            revision.diffCounts?.[change] ?? 0,
          ])}
        />
      ) : null}
    </div>
  );
}
