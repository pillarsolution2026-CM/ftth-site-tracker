'use client';

import { useState } from 'react';
import type {
  DrawingProblemCode,
  DrawingProblemItem,
  DrawingProblemView,
  ProblemSeverity,
} from '@ftth/shared';
import { ltr } from '@ftth/i18n';
import { errorCodeOf } from '@/shared/api/bff-client';
import { Button } from '@/shared/ui/button';
import { ErrorNotice } from '@/shared/ui/error-notice';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { Table, Td, Th } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import { BoxTypeIssueList } from '@/features/box-types/components/box-type-issues';
import { useBoxTypesReport } from '@/features/box-types/api/queries';
import { useDrawingProblems } from '../api/queries';
import { useFixTools, type FixTools } from '../hooks/use-fix-tools';
import type { ShowPlace } from '../hooks/use-drawing-viewer';
import { TYPE_ON_LAYER_CODES, placeDetail, splitProblems } from '../model/problem-detail';
import { FixTool } from './fix-tool';

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
  cadFileId,
  enabled,
  canFix,
  onShowOnDrawing,
}: {
  projectId: string;
  revisionId: string;
  cadFileId: string;
  enabled: boolean;
  /** Draft revision and `design:write`: the fix tools are offered. */
  canFix: boolean;
  /** Zoom the drawing viewer to a place and highlight it. */
  onShowOnDrawing?: (place: Omit<ShowPlace, 'nonce'>) => void;
}) {
  const { t } = useI18n();
  const query = useDrawingProblems(projectId, revisionId, enabled);
  const tools = useFixTools(projectId, cadFileId, enabled && canFix);
  const boxTypes = useBoxTypesReport(projectId, revisionId, enabled);
  const { blocking, warnings } = splitProblems(query.data?.items ?? []);
  const total = query.data?.total ?? 0;
  const warningTotal = query.data?.warningTotal ?? 0;
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
      {query.isSuccess && blocking.length === 0 ? (
        <Notice kind="success">{t('design.problems.none')}</Notice>
      ) : null}
      {blocking.map((problem) => (
        <ProblemBlock key={problem.code} problem={problem} tools={tools} onShow={onShowOnDrawing} />
      ))}
      {warnings.length > 0 ? (
        <>
          <h3 id="warnings-title" className="mt-2 text-base font-semibold">
            <span aria-hidden="true">⚠ </span>
            {t('design.problems.warningsHeading', { total: ltr(warningTotal) })}
          </h3>
          <p className="text-sm">{t('design.problems.warningNote')}</p>
          {warnings.map((problem) => (
            <ProblemBlock
              key={problem.code}
              problem={problem}
              tools={tools}
              onShow={onShowOnDrawing}
              warning
            />
          ))}
        </>
      ) : null}
      {boxTypes.data?.applies && boxTypes.data.issueCount > 0 ? (
        <div className="mt-2 flex flex-col gap-2 rounded-md border border-(--color-border) p-3">
          <h3 id="problems-box-types" className="text-base font-semibold">
            {t('design.boxTypes.title')} <Ltr>({boxTypes.data.issueCount})</Ltr>
          </h3>
          <p className="text-sm">{t('design.boxTypes.problemsHint')}</p>
          <BoxTypeIssueList
            issues={boxTypes.data.issues}
            issueCount={boxTypes.data.issueCount}
            gallery={boxTypes.data.gallery}
            onShowHandle={
              onShowOnDrawing
                ? (handle) => onShowOnDrawing({ code: null, handle, x: null, y: null })
                : undefined
            }
          />
        </div>
      ) : null}
    </section>
  );
}

type OnShow = ((place: Omit<ShowPlace, 'nonce'>) => void) | undefined;

function ProblemBlock({
  problem,
  tools,
  onShow,
  warning = false,
}: {
  problem: DrawingProblemView;
  tools: FixTools;
  onShow: OnShow;
  /** A non-blocking problem (ADR-041): shown apart, with its own note. */
  warning?: boolean;
}) {
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
      {warning ? (
        <p className="text-sm font-semibold">
          <span aria-hidden="true">⚠ </span>
          {t('design.problems.warningNote')}
        </p>
      ) : null}
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
            <PlaceRow
              key={item.handle}
              code={problem.code}
              item={item}
              tools={tools}
              onShow={onShow}
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
  code,
  item,
  tools,
  onShow,
}: {
  code: DrawingProblemCode;
  item: DrawingProblemItem;
  tools: FixTools;
  onShow: OnShow;
}) {
  const { t } = useI18n();
  const zoom = `ZOOM C ${round(item.drawingX)},${round(item.drawingY)}`;
  const detail = placeDetail(code, item, t);
  return (
    <tr>
      <Td>
        {detail ? <div className="text-sm font-semibold">{detail}</div> : null}
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
        {onShow ? (
          <Button
            variant="outline"
            className="mt-2"
            onClick={() =>
              onShow({ code, handle: item.handle, x: item.drawingX, y: item.drawingY })
            }
          >
            {t('design.viewer.showOnDrawing')}
          </Button>
        ) : null}
        <FixTool code={code} place={item} tools={tools} />
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
            {t(
              TYPE_ON_LAYER_CODES.includes(code)
                ? 'design.problems.typeOn'
                : 'design.problems.moveTo',
            )}
            : <Ltr className="break-all">{item.suggestedLayer}</Ltr>
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
