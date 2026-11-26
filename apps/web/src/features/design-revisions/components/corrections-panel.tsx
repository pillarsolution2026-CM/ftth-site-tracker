'use client';

import { ltr } from '@ftth/i18n';
import { dependantsOf, type DrawingCorrection } from '@ftth/shared';
import { Button } from '@/shared/ui/button';
import { ErrorNotice } from '@/shared/ui/error-notice';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { Table, Td, Th } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import { useCorrectionsPanel } from '../hooks/use-corrections-panel';

type PanelState = ReturnType<typeof useCorrectionsPanel>;

/** The panel with its state; on a draft with `design:write` it also withdraws and rebuilds. */
export function CorrectionsSection(props: Parameters<typeof useCorrectionsPanel>[0]) {
  const state = useCorrectionsPanel(props);
  return <CorrectionsPanel state={state} canRebuild={props.canEdit} />;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/**
 * The corrections in force that withdrawing `id` withdraws too (ADR-061): later edits of the
 * item it drew, copies of it and their edits, in the order the build applies them.
 */
function withdrawnWith(id: string, items: readonly DrawingCorrection[]): string[] {
  const inForce = items
    .filter((item) => item.withdrawnAt === null)
    .sort(
      (a, b) =>
        Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  return dependantsOf(id, inForce);
}

/**
 * Corrections made on the program page for this drawing (ADR-038): newest first, who and when,
 * withdrawn ones kept in history, and the prominent rebuild button that applies them.
 */
export function CorrectionsPanel({
  state,
  canRebuild,
}: {
  state: PanelState;
  /** Draft revision and `design:write`: withdraw and rebuild are offered. */
  canRebuild: boolean;
}) {
  const { t, locale } = useI18n();
  const when = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(iso),
    );
  const dependants =
    state.withdrawingId === null ? 0 : withdrawnWith(state.withdrawingId, state.items).length;
  return (
    <section aria-labelledby="corrections-title" className="flex flex-col gap-3">
      <h2 id="corrections-title" className="text-lg font-semibold">
        {t('design.corrections.heading', { active: ltr(state.activeCount) })}
      </h2>
      <p className="text-sm opacity-80">{t('design.corrections.hint')}</p>
      {state.loadErrorCode ? <ErrorNotice code={state.loadErrorCode} /> : null}
      {state.loading ? <p role="status">{t('common.loading')}</p> : null}
      {canRebuild ? (
        <div className="flex flex-col gap-2 rounded-md border-2 border-(--color-brand) p-3">
          <Button
            variant={state.changes > 0 ? 'primary' : 'outline'}
            onClick={state.rebuild}
            disabled={!state.canRebuild}
          >
            {state.rebuilding
              ? t('design.corrections.rebuilding')
              : t('design.corrections.rebuild')}
          </Button>
          <p className="text-sm">
            {state.changes > 0
              ? t('design.corrections.changesSince', { count: ltr(state.changes) })
              : t('design.corrections.noChangesSince')}
          </p>
          <p className="text-sm opacity-80">{t('design.corrections.rebuildText')}</p>
          {state.mappingMissing ? (
            <Notice kind="info">{t('design.corrections.mappingMissing')}</Notice>
          ) : null}
        </div>
      ) : null}
      {state.error ? <Notice kind="error">{t(state.error.key, state.error.params)}</Notice> : null}
      {state.withdrawingId !== null ? (
        <div
          role="alertdialog"
          aria-labelledby="withdraw-title"
          aria-describedby="withdraw-text"
          className="flex flex-col gap-3 rounded-md border-2 border-(--status-rejected) p-4"
        >
          <h3 id="withdraw-title" className="text-base font-semibold">
            <span aria-hidden="true">⚠ </span>
            {t('design.corrections.withdrawTitle')}
          </h3>
          <p id="withdraw-text">
            {t('design.corrections.withdrawText')}
            {dependants > 0 ? (
              <>
                {' '}
                <strong>
                  {t('design.corrections.withdrawDependants', { count: ltr(dependants) })}
                </strong>
              </>
            ) : null}
          </p>
          <div className="flex flex-wrap gap-3">
            <Button onClick={state.withdraw} disabled={state.withdrawing}>
              {t('design.corrections.withdrawConfirm')}
            </Button>
            <Button variant="outline" onClick={state.cancelWithdraw} disabled={state.withdrawing}>
              {t('design.actions.cancel')}
            </Button>
          </div>
        </div>
      ) : null}
      {state.items.length === 0 && !state.loading && !state.loadErrorCode ? (
        <p>{t('design.corrections.none')}</p>
      ) : null}
      {state.items.length > 0 ? (
        <Table aria-labelledby="corrections-title">
          <thead>
            <tr>
              <Th>{t('design.corrections.colKind')}</Th>
              <Th>{t('design.corrections.colValues')}</Th>
              <Th>{t('design.corrections.colMadeBy')}</Th>
              <Th>{t('design.corrections.colState')}</Th>
              {canRebuild ? <Th>{t('common.actions')}</Th> : null}
            </tr>
          </thead>
          <tbody>
            {state.items.map((item) => (
              <tr key={item.id}>
                <Td>{t(`design.corrections.kind.${item.correction.kind}`)}</Td>
                <Td>
                  <Values item={item} />
                  {item.problem ? (
                    <div className="text-sm opacity-80">
                      {t('design.corrections.answers', {
                        problem: t(`design.problems.code.${item.problem.code}`),
                      })}{' '}
                      <Ltr>{item.problem.handle}</Ltr>
                    </div>
                  ) : null}
                </Td>
                <Td>
                  {item.createdBy?.name ?? '—'}
                  <div className="text-sm opacity-80">{when(item.createdAt)}</div>
                </Td>
                <Td>
                  {item.withdrawnAt === null ? (
                    <span>
                      <span aria-hidden="true">✔ </span>
                      {t('design.corrections.active')}
                    </span>
                  ) : (
                    <span>
                      <span aria-hidden="true">↩ </span>
                      {t('design.corrections.withdrawn')}
                      <div className="text-sm opacity-80">
                        {item.withdrawnBy?.name ?? '—'} · {when(item.withdrawnAt)}
                      </div>
                    </span>
                  )}
                </Td>
                {canRebuild ? (
                  <Td>
                    {item.withdrawnAt === null ? (
                      <Button
                        variant="outline"
                        onClick={() => state.askWithdraw(item.id)}
                        disabled={state.withdrawing || state.withdrawingId !== null}
                      >
                        {t('design.corrections.withdraw')}
                      </Button>
                    ) : null}
                  </Td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}
    </section>
  );
}

function Values({ item }: { item: DrawingCorrection }) {
  const { t } = useI18n();
  const c = item.correction;
  switch (c.kind) {
    case 'move_layer':
      return (
        <>
          {t('design.corrections.values.move_layer')} <Ltr>{c.handle}</Ltr> →{' '}
          <Ltr className="break-all">{c.toLayer}</Ltr>
        </>
      );
    case 'set_text':
      return (
        <>
          {t('design.corrections.values.set_text')} <Ltr>{c.handle}</Ltr>: <Ltr>{c.text}</Ltr>
        </>
      );
    case 'add_text':
      return (
        <>
          <Ltr>{c.text}</Ltr> — <Ltr className="break-all">{c.layer}</Ltr>{' '}
          <Ltr>
            ({round(c.x)}, {round(c.y)})
          </Ltr>
        </>
      );
    case 'add_item':
      return (
        <>
          <Ltr className="break-all">{c.layer}</Ltr>{' '}
          <Ltr>
            ({round(c.x)}, {round(c.y)})
          </Ltr>
        </>
      );
    case 'merge_routes':
      return (
        <>
          {t('design.corrections.values.merge_routes', { count: ltr(c.handles.length) })}{' '}
          <Ltr>{c.handles.join(' / ')}</Ltr>
        </>
      );
    case 'dismiss_problem':
      return (
        <>
          {t(`design.problems.code.${c.code}`)} <Ltr>{c.handle}</Ltr> —{' '}
          {t('design.corrections.values.dismiss_problem')}: <bdi>{c.reason}</bdi>
        </>
      );
    case 'move_item':
      return (
        <>
          <Ltr>{c.handle}</Ltr>{' '}
          <Ltr>
            (Δx {round(c.dx)}, Δy {round(c.dy)})
          </Ltr>
        </>
      );
    case 'rotate_item':
      return (
        <>
          <Ltr>{c.handle}</Ltr>{' '}
          <Ltr>
            {round(c.angle)}° @ ({round(c.x)}, {round(c.y)})
          </Ltr>
        </>
      );
    case 'erase_item':
      return <Ltr>{c.handle}</Ltr>;
    case 'copy_item':
      return (
        <>
          <Ltr>{c.handle}</Ltr>{' '}
          <Ltr>
            (Δx {round(c.dx)}, Δy {round(c.dy)})
          </Ltr>
          {c.toLayer !== null ? (
            <>
              {' '}
              → <Ltr className="break-all">{c.toLayer}</Ltr>
            </>
          ) : null}
        </>
      );
    case 'mirror_item':
      return (
        <>
          <Ltr>{c.handle}</Ltr>{' '}
          <Ltr>
            ({round(c.x1)}, {round(c.y1)}) – ({round(c.x2)}, {round(c.y2)})
          </Ltr>
        </>
      );
    case 'scale_item':
      return (
        <>
          <Ltr>{c.handle}</Ltr>{' '}
          <Ltr>
            ×{round(c.factor)} @ ({round(c.x)}, {round(c.y)})
          </Ltr>
        </>
      );
    case 'add_curve':
      return (
        <>
          <Ltr className="break-all">{c.layer}</Ltr> —{' '}
          {t('design.corrections.values.curvePoints', { count: ltr(c.points.length) })}
        </>
      );
    case 'add_layer':
      return (
        <>
          <Ltr className="break-all">{c.layer}</Ltr> {t('design.corrections.values.layerLike')}{' '}
          <Ltr className="break-all">{c.like}</Ltr>
        </>
      );
    case 'rename_layer':
      return (
        <>
          <Ltr className="break-all">{c.from}</Ltr> → <Ltr className="break-all">{c.to}</Ltr>
        </>
      );
    case 'delete_layer':
      return (
        <>
          <Ltr className="break-all">{c.layer}</Ltr> —{' '}
          {t('design.corrections.values.layerEverything')}
        </>
      );
    case 'set_curve':
      return (
        <>
          <Ltr>{c.handle}</Ltr> —{' '}
          {t('design.corrections.values.curvePoints', { count: ltr(c.points.length) })}
        </>
      );
    case 'add_note':
      return (
        <>
          {t(`design.corrections.values.note_${c.note}`)} <Ltr className="break-all">{c.layer}</Ltr>
          {c.text !== null && (
            <>
              {' '}
              — <bdi>{c.text}</bdi>
            </>
          )}{' '}
          ({t('design.corrections.values.screenOnly')})
        </>
      );
    case 'set_style': {
      const byLayer = t('design.corrections.values.byLayer');
      return (
        <>
          <Ltr>{c.handle}</Ltr>{' '}
          <Ltr>
            {c.color ?? byLayer} · {c.linetype ?? byLayer} ·{' '}
            {c.lineweight === null ? byLayer : `${round(c.lineweight)} mm`}
          </Ltr>{' '}
          ({t('design.corrections.values.screenOnly')})
        </>
      );
    }
    case 'add_shape':
      return (
        <>
          {t(`design.corrections.values.shape_${c.shape}`)}
          {c.pattern !== null ? <Ltr> {c.pattern}</Ltr> : null}{' '}
          <Ltr className="break-all">{c.layer}</Ltr> ({t('design.corrections.values.screenOnly')})
        </>
      );
    case 'merge_layer':
      return (
        <>
          <Ltr className="break-all">{c.from}</Ltr> → <Ltr className="break-all">{c.to}</Ltr>
        </>
      );
    case 'set_attribute':
      return (
        <>
          <Ltr>{c.handle}</Ltr> <bdi>{c.from}</bdi> → <bdi>{c.to}</bdi>
        </>
      );
    case 'set_group':
      return (
        <>
          <bdi>{c.name}</bdi>{' '}
          {c.handles.length === 0
            ? t('design.corrections.values.ungrouped')
            : t('design.corrections.values.groupCount', { count: c.handles.length })}{' '}
          ({t('design.corrections.values.screenOnly')})
        </>
      );
    case 'set_order':
      return (
        <>
          <Ltr>{c.handle}</Ltr> {t('design.corrections.values.order')} <Ltr>{round(c.order)}</Ltr> (
          {t('design.corrections.values.screenOnly')})
        </>
      );
    case 'set_text_format':
      return (
        <>
          <Ltr>{c.handle}</Ltr>{' '}
          <Ltr>
            {[
              c.widthFactor !== null ? `W ${round(c.widthFactor)}` : null,
              c.mtext ? 'MText' : null,
              c.mask ? 'Mask' : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </Ltr>{' '}
          ({t('design.corrections.values.screenOnly')})
        </>
      );
    case 'add_table':
      return (
        <>
          <Ltr>
            {t('design.corrections.values.tableSize', {
              rows: c.rows.length,
              columns: c.columns.length,
            })}
          </Ltr>{' '}
          <Ltr className="break-all">{c.layer}</Ltr> ({t('design.corrections.values.screenOnly')})
        </>
      );
  }
}
