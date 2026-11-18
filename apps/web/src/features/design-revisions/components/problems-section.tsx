'use client';

import { useMemo, useState } from 'react';
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
import { useI18n } from '@/shared/i18n/locale-provider';
import { BoxTypeIssueList } from '@/features/box-types/components/box-type-issues';
import { useBoxTypesReport } from '@/features/box-types/api/queries';
import { useDesignRevision, useDrawingProblems } from '../api/queries';
import { useFixTools, type FixTools } from '../hooks/use-fix-tools';
import type { ShowPlace } from '../hooks/use-drawing-viewer';
import { TYPE_ON_LAYER_CODES, placeDetail, splitProblems } from '../model/problem-detail';
import { FixTool } from './fix-tool';

const SEVERITY_ICON: Readonly<Record<ProblemSeverity, string>> = {
  error: '⛔',
  warning: '⚠',
  info: 'ℹ',
};

const round = (value: number) => Math.round(value * 100) / 100;

type Filter = 'open' | 'errors' | 'warnings' | 'fixed';

interface Entry {
  key: string;
  code: DrawingProblemCode;
  severity: ProblemSeverity;
  /** Does not block publishing (ADR-041). */
  warning: boolean;
  item: DrawingProblemItem;
  fixed: boolean;
}

type OnShow = ((place: Omit<ShowPlace, 'nonce'>) => void) | undefined;

/**
 * The drawing errors as a work list beside the drawing (ADR-038, redesigned ADR-050 part 3): a
 * progress line, filters, one short row per place; the chosen place opens a card with what to do,
 * its fix tool and ✕, «next»; coordinates and handles are under «details».
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
  const revision = useDesignRevision(projectId, revisionId, enabled && canFix);
  const tools = useFixTools(
    projectId,
    cadFileId,
    enabled && canFix,
    revision.data?.createdAt ?? null,
  );
  const boxTypes = useBoxTypesReport(projectId, revisionId, enabled);
  const { blocking, warnings } = splitProblems(query.data?.items ?? []);
  const total = query.data?.total ?? 0;

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    const push = (problems: readonly DrawingProblemView[], warning: boolean) => {
      for (const problem of problems) {
        for (const item of problem.items) {
          out.push({
            key: `${problem.code}:${item.handle}`,
            code: problem.code,
            severity: problem.severity,
            warning,
            item,
            fixed: tools.isPending(problem.code, item.handle),
          });
        }
      }
    };
    push(blocking, false);
    push(warnings, true);
    return out;
    // tools.isPending changes with the corrections list
  }, [blocking, warnings, tools]);

  const errorsOpen = entries.filter((e) => !e.warning && !e.fixed);
  const errorsAll = entries.filter((e) => !e.warning);
  const counts: Record<Filter, number> = {
    open: entries.filter((e) => !e.fixed).length,
    errors: errorsOpen.length,
    warnings: entries.filter((e) => e.warning && !e.fixed).length,
    fixed: entries.filter((e) => e.fixed).length,
  };
  const [filter, setFilter] = useState<Filter>('open');
  const shown = entries.filter((e) =>
    filter === 'open'
      ? !e.fixed
      : filter === 'errors'
        ? !e.warning && !e.fixed
        : filter === 'warnings'
          ? e.warning && !e.fixed
          : e.fixed,
  );
  const [selected, setSelected] = useState<string | null>(null);
  // Start on the first open place (the drawing is not moved until the user picks one).
  const current = shown.find((e) => e.key === selected) ?? shown[0] ?? null;
  const index = current ? shown.indexOf(current) : -1;

  const choose = (entry: Entry, zoom: boolean) => {
    setSelected(entry.key);
    if (zoom) {
      onShowOnDrawing?.({
        code: entry.code,
        handle: entry.item.handle,
        x: entry.item.drawingX,
        y: entry.item.drawingY,
      });
    }
  };

  const done = errorsAll.length - errorsOpen.length;
  return (
    <section aria-labelledby="problems-title" className="flex flex-col gap-3">
      <h2 id="problems-title" className="text-lg font-semibold">
        {query.isSuccess
          ? t('design.problems.heading', { total: ltr(total) })
          : t('design.problems.title')}
      </h2>
      {query.error ? <ErrorNotice code={errorCodeOf(query.error)} /> : null}
      {query.isLoading ? <p role="status">{t('common.loading')}</p> : null}
      {query.isSuccess && blocking.length === 0 ? (
        <Notice kind="success">{t('design.problems.none')}</Notice>
      ) : null}
      {errorsAll.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-sm font-semibold" aria-live="polite">
            {t('design.problems.nav.progress', {
              open: ltr(errorsOpen.length),
              done: ltr(done),
              total: ltr(errorsAll.length),
            })}
          </p>
          <progress
            className="h-2 w-full"
            max={errorsAll.length}
            value={done}
            aria-label={t('design.problems.nav.progressLabel')}
          />
        </div>
      ) : null}
      {entries.length > 0 ? (
        <div
          role="group"
          aria-label={t('design.problems.nav.filter')}
          className="flex flex-wrap gap-1"
        >
          {(['open', 'errors', 'warnings', 'fixed'] as const).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              onClick={() => {
                setFilter(key);
                setSelected(null);
              }}
              className={`min-h-9 rounded-full border px-3 text-sm focus-visible:outline-2 focus-visible:outline-(--color-focus) ${
                filter === key
                  ? 'border-(--color-brand) bg-(--color-brand) text-(--color-brandContrast)'
                  : 'border-(--color-border)'
              }`}
            >
              {t(`design.problems.nav.filters.${key}`)} <Ltr>({counts[key]})</Ltr>
            </button>
          ))}
        </div>
      ) : null}
      {entries.length > 0 && shown.length === 0 ? (
        <p className="text-sm">{t('design.problems.nav.emptyFilter')}</p>
      ) : null}
      <ol className="flex flex-col gap-1">
        {shown.map((entry) => {
          const open = current?.key === entry.key;
          const cardId = `place-${entry.key.replace(/[^a-zA-Z0-9-]/g, '_')}`;
          return (
            <li key={entry.key}>
              <button
                type="button"
                aria-expanded={open}
                aria-controls={cardId}
                onClick={() => choose(entry, true)}
                className={`flex w-full items-start gap-2 rounded-md border px-3 py-2 text-start focus-visible:outline-2 focus-visible:outline-(--color-focus) ${
                  open ? 'border-(--color-brand) bg-(--color-brand)/5' : 'border-(--color-border)'
                }`}
              >
                <span
                  role="img"
                  aria-label={t('design.problems.severityHint', {
                    severity: t(`design.problems.severity.${entry.severity}`),
                  })}
                  className="pt-0.5"
                >
                  {entry.fixed ? '✔' : SEVERITY_ICON[entry.severity]}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-semibold">{t(`design.problems.code.${entry.code}`)}</span>
                  <span className="truncate text-sm opacity-80">{subtitle(entry, t)}</span>
                </span>
                {entry.fixed ? (
                  <span className="shrink-0 rounded-full bg-green-100 px-2 text-xs text-green-900">
                    {t('design.problems.nav.fixedChip')}
                  </span>
                ) : null}
              </button>
              {open ? (
                <PlaceCard
                  id={cardId}
                  entry={entry}
                  tools={tools}
                  onShow={onShowOnDrawing}
                  position={index + 1}
                  count={shown.length}
                  onPrev={index > 0 ? () => choose(shown[index - 1] as Entry, true) : undefined}
                  onNext={
                    index < shown.length - 1
                      ? () => choose(shown[index + 1] as Entry, true)
                      : undefined
                  }
                />
              ) : null}
            </li>
          );
        })}
      </ol>
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

type T = ReturnType<typeof useI18n>['t'];

/** One short line under the error name: what is special about the place, else where it is. */
function subtitle(entry: Entry, t: T): string {
  const detail = placeDetail(entry.code, entry.item, t);
  if (detail) return detail;
  const near = entry.item.near;
  if (near) {
    return t('design.problems.nav.near', {
      what: t(`featureType.${near.type}`),
      name: near.name ? ltr(near.name) : '',
      distance: ltr(round(near.distanceM)),
    });
  }
  return entry.item.text ? ltr(entry.item.text) : ltr(entry.item.layer);
}

function PlaceCard({
  id,
  entry,
  tools,
  onShow,
  position,
  count,
  onPrev,
  onNext,
}: {
  id: string;
  entry: Entry;
  tools: FixTools;
  onShow: OnShow;
  position: number;
  count: number;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const { t } = useI18n();
  const { code, item } = entry;
  const zoom = `ZOOM C ${round(item.drawingX)},${round(item.drawingY)}`;
  return (
    <div id={id} className="mt-1 flex flex-col gap-2 rounded-md border border-(--color-border) p-3">
      {entry.warning ? (
        <p className="text-sm font-semibold">
          <span aria-hidden="true">⚠ </span>
          {t('design.problems.warningNote')}
        </p>
      ) : null}
      <p className="text-sm">
        <span className="font-semibold">{t('design.problems.fixLabel')}: </span>
        {t(`design.problems.${code}.fix`)}
      </p>
      <p className="text-sm">
        {t('design.problems.layer')}: <Ltr className="break-all">{item.layer}</Ltr>
        {item.text ? (
          <>
            {' · '}
            {t('design.problems.label')}: <Ltr>{item.text}</Ltr>
          </>
        ) : null}
        {item.suggestedLayer ? (
          <>
            {' · '}
            {t(
              TYPE_ON_LAYER_CODES.includes(code)
                ? 'design.problems.typeOn'
                : 'design.problems.moveTo',
            )}
            : <Ltr className="break-all">{item.suggestedLayer}</Ltr>
          </>
        ) : null}
      </p>
      {onShow ? (
        <Button
          variant="outline"
          onClick={() => onShow({ code, handle: item.handle, x: item.drawingX, y: item.drawingY })}
        >
          {t('design.viewer.showOnDrawing')}
        </Button>
      ) : null}
      <FixTool code={code} place={item} tools={tools} defaultOpen />
      <details className="text-sm">
        <summary className="cursor-pointer opacity-80">{t('design.problems.nav.details')}</summary>
        <div className="mt-1 flex flex-col gap-0.5">
          <span>
            {t('design.problems.whatLabel')}: {t(`design.problems.${code}.description`)}
          </span>
          <span>
            {t('design.problems.drawingXY')}:{' '}
            <Ltr>
              {round(item.drawingX)}, {round(item.drawingY)}
            </Ltr>
          </span>
          <span>
            {t('design.problems.projectEN')}:{' '}
            <Ltr>
              {round(item.x)}, {round(item.y)}
            </Ltr>
          </span>
          <span className="opacity-80">
            <Ltr>{zoom}</Ltr>
          </span>
          <span className="opacity-80">
            {t('design.problems.handle')}: <Ltr>{item.handle}</Ltr>
          </span>
        </div>
      </details>
      <div className="flex items-center justify-between gap-2">
        <Button variant="outline" onClick={onPrev} disabled={!onPrev}>
          {t('design.problems.nav.prev')}
        </Button>
        <span className="text-sm opacity-80">
          <Ltr>
            {position} / {count}
          </Ltr>
        </span>
        <Button onClick={onNext} disabled={!onNext}>
          {t('design.problems.nav.next')}
        </Button>
      </div>
    </div>
  );
}
