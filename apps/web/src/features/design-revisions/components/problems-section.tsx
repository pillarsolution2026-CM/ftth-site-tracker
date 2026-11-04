'use client';

import { useState } from 'react';
import type { DrawingProblemItemView, DrawingProblemView, ProblemSeverity } from '@ftth/shared';
import { errorCodeOf } from '@/shared/api/bff-client';
import { formatDateTime } from '@/shared/lib/format';
import { Button } from '@/shared/ui/button';
import { ErrorNotice } from '@/shared/ui/error-notice';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { Table, Td, Th } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import { useDrawingProblems, useIgnoreDrawingProblem } from '../api/queries';

/** Places shown per problem before "show all" (a problem keeps at most 500). */
const FIRST_PLACES = 20;

const SEVERITY_ICON: Readonly<Record<ProblemSeverity, string>> = {
  error: '⛔',
  warning: '⚠',
  info: 'ℹ',
};

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * Drawing problems found by the worker (ADR-033/034), each with its places. A user who may edit
 * the draft fixes the drawing and uploads it again, or ignores a place on their own
 * responsibility after confirming it; who ignored it and when is recorded by the API.
 */
export function ProblemsSection({
  projectId,
  revisionId,
  enabled,
  canIgnore,
}: {
  projectId: string;
  revisionId: string;
  enabled: boolean;
  canIgnore: boolean;
}) {
  const { t } = useI18n();
  const query = useDrawingProblems(projectId, revisionId, enabled);
  const problems = query.data?.items ?? [];
  return (
    <section aria-labelledby="problems-title" className="flex flex-col gap-3">
      <h2 id="problems-title" className="text-lg font-semibold">
        {t('design.problems.title')}
      </h2>
      <p className="text-sm opacity-80">{t('design.problems.hint')}</p>
      {query.error ? <ErrorNotice code={errorCodeOf(query.error)} /> : null}
      {query.isLoading ? <p role="status">{t('common.loading')}</p> : null}
      {query.isSuccess && problems.length === 0 ? (
        <Notice kind="success">{t('design.problems.none')}</Notice>
      ) : null}
      {problems.map((problem) => (
        <ProblemBlock
          key={problem.code}
          projectId={projectId}
          revisionId={revisionId}
          problem={problem}
          canIgnore={canIgnore}
        />
      ))}
    </section>
  );
}

function ProblemBlock({
  projectId,
  revisionId,
  problem,
  canIgnore,
}: {
  projectId: string;
  revisionId: string;
  problem: DrawingProblemView;
  canIgnore: boolean;
}) {
  const { t } = useI18n();
  const [showAll, setShowAll] = useState(false);
  const places = showAll ? problem.items : problem.items.slice(0, FIRST_PLACES);
  const headingId = `problem-${problem.code}`;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-(--color-border) p-3">
      <h3 id={headingId} className="text-base font-semibold">
        <span aria-hidden="true">{SEVERITY_ICON[problem.severity]} </span>
        {t(`design.problems.severity.${problem.severity}`)}:{' '}
        {t(`design.problems.code.${problem.code}`)} <Ltr>({problem.count})</Ltr>
      </h3>
      <p className="text-sm">{t(`design.problems.explain.${problem.code}`)}</p>
      <p className="text-sm opacity-80">
        {t('design.problems.ignoredCount', { count: problem.ignoredCount, total: problem.count })}
      </p>
      <Table aria-labelledby={headingId}>
        <thead>
          <tr>
            <Th>{t('design.problems.place')}</Th>
            <Th>{t('design.problems.layer')}</Th>
            <Th>{t('design.problems.near')}</Th>
            <Th>{t('design.problems.status')}</Th>
          </tr>
        </thead>
        <tbody>
          {places.map((item) => (
            <PlaceRow
              key={item.handle}
              projectId={projectId}
              revisionId={revisionId}
              code={problem.code}
              item={item}
              canIgnore={canIgnore}
            />
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

function PlaceRow({
  projectId,
  revisionId,
  code,
  item,
  canIgnore,
}: {
  projectId: string;
  revisionId: string;
  code: DrawingProblemView['code'];
  item: DrawingProblemItemView;
  canIgnore: boolean;
}) {
  const { t, locale } = useI18n();
  const ignore = useIgnoreDrawingProblem(projectId, revisionId);
  const [confirming, setConfirming] = useState(false);
  const zoom = `ZOOM C ${round(item.drawingX)},${round(item.drawingY)}`;
  return (
    <tr>
      <Td>
        <Ltr>
          {round(item.drawingX)}, {round(item.drawingY)}
        </Ltr>
        <div className="text-sm opacity-80">
          <Ltr>{zoom}</Ltr>
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
      <Td>
        {item.ignored ? (
          <span>
            {t('design.problems.ignoredAt', { at: formatDateTime(item.ignored.at, locale) })}
          </span>
        ) : canIgnore ? (
          confirming ? (
            <div
              role="alertdialog"
              aria-label={t('design.problems.confirmTitle')}
              className="flex flex-col gap-2"
            >
              <p className="text-sm">
                <span aria-hidden="true">⚠ </span>
                {t('design.problems.confirmText')}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={ignore.isPending}
                  onClick={() =>
                    ignore.mutate(
                      { code, handle: item.handle, acceptResponsibility: true },
                      { onSuccess: () => setConfirming(false) },
                    )
                  }
                >
                  {t('design.problems.confirmIgnore')}
                </Button>
                <Button
                  variant="outline"
                  disabled={ignore.isPending}
                  onClick={() => setConfirming(false)}
                >
                  {t('design.actions.cancel')}
                </Button>
              </div>
              {ignore.isError ? (
                <span role="alert" className="text-sm">
                  {t('design.problems.ignoreFailed')}
                </span>
              ) : null}
            </div>
          ) : (
            <Button variant="outline" onClick={() => setConfirming(true)}>
              {t('design.problems.ignore')}
            </Button>
          )
        ) : (
          t('design.problems.open')
        )}
      </Td>
    </tr>
  );
}
