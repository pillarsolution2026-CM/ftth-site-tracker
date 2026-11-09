'use client';

import { ltr } from '@ftth/i18n';
import type { DrawingCorrection } from '@ftth/shared';
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
          <p id="withdraw-text">{t('design.corrections.withdrawText')}</p>
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
  }
}
