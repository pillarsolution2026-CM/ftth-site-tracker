'use client';

import { useState } from 'react';
import type { DrawingProblemItem, DrawingProblemView, ProblemSeverity } from '@ftth/shared';
import { ltr } from '@ftth/i18n';
import { errorCodeOf } from '@/shared/api/bff-client';
import { Button } from '@/shared/ui/button';
import { ErrorNotice } from '@/shared/ui/error-notice';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { Table, Td, Th } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import { useDrawingProblems } from '../api/queries';

/** Places shown per problem before "show all" (a problem keeps at most 500). */
const FIRST_PLACES = 20;

const SEVERITY_ICON: Readonly<Record<ProblemSeverity, string>> = {
  error: '⛔',
  warning: '⚠',
  info: 'ℹ',
};

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * The drawing error report (ADR-038). Every problem is an error that blocks publishing; per type
 * it says what it is, what is required to fix it, and where each place is (drawing and project
 * coordinates, layer, nearest named item). Severity is only a small hint icon with text.
 */
export function ProblemsSection({
  projectId,
  revisionId,
  enabled,
}: {
  projectId: string;
  revisionId: string;
  enabled: boolean;
}) {
  const { t } = useI18n();
  const query = useDrawingProblems(projectId, revisionId, enabled);
  const problems = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  return (
    <section aria-labelledby="problems-title" className="flex flex-col gap-3">
      <h2 id="problems-title" className="text-lg font-semibold">
        {query.isSuccess
          ? t('design.problems.heading', { total: ltr(total) })
          : t('design.problems.title')}
      </h2>
      <p className="text-sm opacity-80">{t('design.problems.hint')}</p>
      {query.error ? <ErrorNotice code={errorCodeOf(query.error)} /> : null}
      {query.isLoading ? <p role="status">{t('common.loading')}</p> : null}
      {query.isSuccess && problems.length === 0 ? (
        <Notice kind="success">{t('design.problems.none')}</Notice>
      ) : null}
      {problems.map((problem) => (
        <ProblemBlock key={problem.code} problem={problem} />
      ))}
    </section>
  );
}

function ProblemBlock({ problem }: { problem: DrawingProblemView }) {
  const { t } = useI18n();
  const [showAll, setShowAll] = useState(false);
  const places = showAll ? problem.items : problem.items.slice(0, FIRST_PLACES);
  const headingId = `problem-${problem.code}`;
  const severity = t(`design.problems.severity.${problem.severity}`);
  return (
    <div className="flex flex-col gap-2 rounded-md border border-(--color-border) p-3">
      <h3 id={headingId} className="text-base font-semibold">
        {t(`design.problems.code.${problem.code}`)} <Ltr>({problem.count})</Ltr>{' '}
        <span
          role="img"
          title={t('design.problems.severityHint', { severity })}
          aria-label={t('design.problems.severityHint', { severity })}
          className="text-sm font-normal"
        >
          {SEVERITY_ICON[problem.severity]}
        </span>
      </h3>
      <dl className="flex flex-col gap-1 text-sm">
        <div>
          <dt className="font-semibold">{t('design.problems.whatLabel')}</dt>
          <dd>{t(`design.problems.${problem.code}.description`)}</dd>
        </div>
        <div>
          <dt className="font-semibold">{t('design.problems.fixLabel')}</dt>
          <dd>{t(`design.problems.${problem.code}.fix`)}</dd>
        </div>
      </dl>
      <Table aria-labelledby={headingId}>
        <thead>
          <tr>
            <Th>{t('design.problems.place')}</Th>
            <Th>{t('design.problems.layer')}</Th>
            <Th>{t('design.problems.near')}</Th>
          </tr>
        </thead>
        <tbody>
          {places.map((item) => (
            <PlaceRow key={item.handle} item={item} />
          ))}
        </tbody>
      </Table>
      {problem.items.length > FIRST_PLACES ? (
        <Button variant="outline" onClick={() => setShowAll((value) => !value)}>
          {showAll
            ? t('design.problems.showFirst', { count: FIRST_PLACES })
            : t('design.problems.showAll', { count: problem.items.length })}
        </Button>
      ) : null}
      {problem.count > problem.items.length ? (
        <p className="text-sm">
          {t('design.problems.moreThanListed', { listed: problem.items.length })}
        </p>
      ) : null}
    </div>
  );
}

function PlaceRow({ item }: { item: DrawingProblemItem }) {
  const { t } = useI18n();
  const zoom = `ZOOM C ${round(item.drawingX)},${round(item.drawingY)}`;
  return (
    <tr>
      <Td>
        <div className="text-sm">
          {t('design.problems.drawingXY')}:{' '}
          <Ltr>
            {round(item.drawingX)}, {round(item.drawingY)}
          </Ltr>
        </div>
        <div className="text-sm">
          {t('design.problems.projectEN')}:{' '}
          <Ltr>
            {round(item.x)}, {round(item.y)}
          </Ltr>
        </div>
        <div className="text-sm opacity-80">
          <Ltr>{zoom}</Ltr>
        </div>
        <div className="text-sm opacity-80">
          {t('design.problems.handle')}: <Ltr>{item.handle}</Ltr>
        </div>
      </Td>
      <Td>
        <Ltr className="break-all">{item.layer}</Ltr>
        {item.text ? (
          <div className="text-sm">
            {t('design.problems.label')}: <Ltr>{item.text}</Ltr>
          </div>
        ) : null}
        {item.suggestedLayer ? (
          <div className="text-sm">
            {t('design.problems.moveTo')}: <Ltr className="break-all">{item.suggestedLayer}</Ltr>
          </div>
        ) : null}
      </Td>
      <Td>
        {item.near ? (
          <>
            {t(`featureType.${item.near.type}`)}{' '}
            {item.near.name ? <Ltr>{item.near.name}</Ltr> : null}{' '}
            <Ltr>({round(item.near.distanceM)} m)</Ltr>
          </>
        ) : (
          '—'
        )}
      </Td>
    </tr>
  );
}
