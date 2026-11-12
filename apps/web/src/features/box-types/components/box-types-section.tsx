'use client';

import { ltr } from '@ftth/i18n';
import type { BoxShape } from '@ftth/shared';
import { Button } from '@/shared/ui/button';
import { ErrorNotice } from '@/shared/ui/error-notice';
import { Select } from '@/shared/ui/form-controls';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import { useBoxTypesSection, type BoxTypesSectionState } from '../hooks/use-box-types-section';
import { lineOptionText, shapePickerId, shapeShortId, shapeCardId } from '../model/box-types-model';
import { BoxTypeIssueList } from './box-type-issues';
import { ShapePreview } from './shape-preview';

/**
 * «أنواع البوكسات» on the Secondary's draft page (ADR-043): one card per drawn shape with its
 * picture, number of boxes and block names, and a picker over the lines of the work order. The
 * state hook runs inside, so the section sits on any page; it renders nothing for a General.
 */
export function BoxTypesSection(
  props: Parameters<typeof useBoxTypesSection>[0] & {
    /** Zoom the drawing viewer to a box handle. */
    onShowHandle?: (handle: string) => void;
  },
) {
  const { onShowHandle, ...input } = props;
  const state = useBoxTypesSection(input);
  return <BoxTypes state={state} onShowHandle={onShowHandle} />;
}

export function BoxTypes({
  state,
  onShowHandle,
}: {
  state: BoxTypesSectionState;
  onShowHandle: ((handle: string) => void) | undefined;
}) {
  const { t } = useI18n();
  if (state.loadErrorCode) return <ErrorNotice code={state.loadErrorCode} />;
  if (state.loading) return <p role="status">{t('common.loading')}</p>;
  if (!state.applies || !state.report) return null;
  const { report } = state;
  return (
    <section aria-labelledby="box-types-title" className="flex flex-col gap-3">
      <h2 id="box-types-title" className="text-lg font-semibold">
        {t('design.boxTypes.title')}
      </h2>
      <p className="text-sm opacity-80">{t('design.boxTypes.hint')}</p>
      {report.gallery === null ? (
        <Notice kind="warning">{t('design.boxTypes.issue.BOX_SHAPES_NOT_READ')}</Notice>
      ) : (
        <p>
          {t('design.boxTypes.summary', {
            boxes: ltr(state.boxCount),
            shapes: ltr(state.shapeCount),
          })}
        </p>
      )}
      {state.workOrder.loading ? <p role="status">{t('common.loading')}</p> : null}
      {!state.workOrder.loading && state.workOrder.failed ? (
        <Notice kind="error">{t('design.boxTypes.linesFailed')}</Notice>
      ) : null}
      {!state.workOrder.loading && !state.workOrder.failed && !state.workOrder.hasWorkOrder ? (
        <Notice kind="warning">{t('design.boxTypes.issue.WORK_ORDER_MISSING')}</Notice>
      ) : null}
      {state.stateFailed ? <Notice kind="error">{t('design.boxTypes.stateFailed')}</Notice> : null}
      {state.rebuildNeeded ? (
        <Notice kind="warning">{t('design.boxTypes.rebuildNeeded')}</Notice>
      ) : null}
      {!state.canEdit ? (
        <p className="text-sm opacity-80">{t('design.boxTypes.readOnly')}</p>
      ) : null}
      {state.canEdit && state.previousCount > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={state.usePrevious} disabled={state.saving}>
            {t('design.boxTypes.usePrevious')}
          </Button>
          <span className="text-sm">
            {t('design.boxTypes.previousHint', { count: ltr(state.previousCount) })}
          </span>
        </div>
      ) : null}
      {report.issueCount > 0 ? (
        <BoxTypeIssueList
          issues={report.issues}
          issueCount={report.issueCount}
          gallery={report.gallery}
          onShowHandle={onShowHandle}
        />
      ) : report.gallery !== null ? (
        <Notice kind="success">{t('design.boxTypes.allClear')}</Notice>
      ) : null}
      <ul className="grid gap-3 md:grid-cols-2">
        {state.shapes.map((shape) => (
          <ShapeCard key={shape.shape} shape={shape} state={state} onShowHandle={onShowHandle} />
        ))}
      </ul>
      {state.canEdit ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={state.save} disabled={state.saving || state.dirtyCount === 0}>
            {state.saving ? t('design.boxTypes.saving') : t('design.boxTypes.save')}
          </Button>
          {state.dirtyCount > 0 ? (
            <span className="text-sm">
              {t('design.boxTypes.unsaved', { count: ltr(state.dirtyCount) })}
            </span>
          ) : null}
        </div>
      ) : null}
      {state.error ? <Notice kind="error">{t(state.error.key, state.error.params)}</Notice> : null}
    </section>
  );
}

function ShapeCard({
  shape,
  state,
  onShowHandle,
}: {
  shape: BoxShape;
  state: BoxTypesSectionState;
  onShowHandle: ((handle: string) => void) | undefined;
}) {
  const { t } = useI18n();
  const value = state.valueOf(shape.shape);
  const saved = state.isSaved(shape.shape);
  const sample = shape.sampleHandles[0];
  const missingLine = value !== '' && !state.lineIds.has(value) && !state.workOrder.loading;
  const name = t('design.boxTypes.shapeName', { shape: ltr(shapeShortId(shape.shape)) });
  return (
    <li
      id={shapeCardId(shape.shape)}
      className="flex gap-3 rounded-md border border-(--color-border) p-3"
    >
      <ShapePreview preview={shape.preview} label={name} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <h3 className="text-base font-semibold">
          {name} <Ltr>({shape.count})</Ltr>
        </h3>
        <p className="text-sm">
          {t('design.boxTypes.count', { count: ltr(shape.count) })}
          {shape.blockNames.length > 0 ? (
            <>
              {' — '}
              {t('design.boxTypes.blocks')}:{' '}
              {shape.blockNames.map((block, index) => (
                <span key={block}>
                  {index > 0 ? '، ' : ''}
                  <Ltr>{block}</Ltr>
                </span>
              ))}
            </>
          ) : null}
        </p>
        <p className="text-sm font-semibold">
          <span aria-hidden="true">{saved ? '✓ ' : '⚠ '}</span>
          {saved ? t('design.boxTypes.chosen') : t('design.boxTypes.unset')}
        </p>
        <Select
          id={shapePickerId(shape.shape)}
          label={t('design.boxTypes.pick')}
          value={value}
          disabled={!state.canEdit || state.saving}
          onChange={(event) => state.pick(shape.shape, event.target.value)}
          error={missingLine ? t('design.boxTypes.lineMissingCard') : undefined}
        >
          <option value="">{t('design.boxTypes.noLine')}</option>
          {missingLine ? <option value={value}>{ltr(value.slice(0, 8))}</option> : null}
          {state.workOrder.lines.map((line) => (
            <option key={line.id} value={line.id}>
              {lineOptionText(line)}
            </option>
          ))}
        </Select>
        {sample && onShowHandle ? (
          <div>
            <Button variant="outline" onClick={() => onShowHandle(sample)}>
              {t('design.boxTypes.showOnDrawing')}
            </Button>
          </div>
        ) : null}
      </div>
    </li>
  );
}
