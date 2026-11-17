'use client';

import { ltr } from '@ftth/i18n';
import { Button } from '@/shared/ui/button';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { Table, Td, Th } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import type { TrenchTool } from '../hooks/use-trench-tool';

/**
 * The «حفر جديد» tool switch, the saved-mark notice and the list of trench marks under the canvas
 * (ADR-042 part D): who made each one, in force or withdrawn (kept in history), with withdraw.
 */
export function TrenchMarksPanel({
  tool,
  onShow,
}: {
  tool: TrenchTool;
  /** Zoom the drawing to a marked route. */
  onShow?: (routeHandle: string) => void;
}) {
  const { t, locale } = useI18n();
  const when = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(iso),
    );
  return (
    <section aria-labelledby="trench-marks-title" className="flex flex-col gap-2">
      <h3 id="trench-marks-title" className="text-base font-semibold">
        {t('design.installation.marks.heading', { count: ltr(tool.activeCount) })}
      </h3>
      <p className="text-sm opacity-80">{t('design.installation.marks.hint')}</p>
      {tool.available ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant={tool.mode ? 'primary' : 'outline'}
            aria-pressed={tool.mode}
            onClick={tool.toggle}
          >
            {tool.mode
              ? `${t('design.installation.tool.button')} — ${t('design.installation.tool.off')}`
              : t('design.installation.tool.button')}
          </Button>
          {tool.mode ? (
            <span className="text-sm" role="status">
              {t('design.installation.tool.on')}
            </span>
          ) : null}
        </div>
      ) : tool.canEdit ? (
        <p className="text-sm">{t('design.installation.tool.unavailable')}</p>
      ) : null}
      {tool.saved ? <Notice kind="success">{t('design.installation.tool.saved')}</Notice> : null}
      {tool.withdrawError ? (
        <Notice kind="error">{t(tool.withdrawError.key, tool.withdrawError.params)}</Notice>
      ) : null}
      {tool.marks.length === 0 ? (
        <p>{t('design.installation.marks.none')}</p>
      ) : (
        <>
          <p className="text-sm font-semibold">
            {t('design.installation.marks.total', { length: ltr(tool.totalM) })}
          </p>
          <Table aria-labelledby="trench-marks-title">
            <thead>
              <tr>
                <Th>{t('design.installation.marks.colRoute')}</Th>
                <Th>{t('design.installation.marks.colLength')}</Th>
                <Th>{t('design.installation.marks.colMadeBy')}</Th>
                <Th>{t('design.installation.marks.colState')}</Th>
                <Th>{t('common.actions')}</Th>
              </tr>
            </thead>
            <tbody>
              {tool.marks.map((mark) => {
                const inForce = mark.withdrawnAt === null;
                return (
                  <tr key={mark.id}>
                    <Td>
                      <Ltr>{mark.routeHandle}</Ltr>
                    </Td>
                    <Td>
                      <Ltr>{mark.lengthM}</Ltr>
                    </Td>
                    <Td>
                      {mark.createdBy?.name ?? '—'}
                      <div className="text-sm opacity-80">{when(mark.createdAt)}</div>
                    </Td>
                    <Td>
                      {inForce ? (
                        <span>
                          <span aria-hidden="true">✔ </span>
                          {t('design.installation.marks.active')}
                        </span>
                      ) : (
                        <span>
                          <span aria-hidden="true">↩ </span>
                          {t('design.installation.marks.withdrawn')}
                          <div className="text-sm opacity-80">
                            {mark.withdrawnBy?.name ?? '—'}
                            {mark.withdrawnAt ? ` · ${when(mark.withdrawnAt)}` : ''}
                          </div>
                        </span>
                      )}
                    </Td>
                    <Td>
                      {inForce ? (
                        <div className="flex flex-wrap gap-2">
                          {onShow ? (
                            <Button variant="outline" onClick={() => onShow(mark.routeHandle)}>
                              {t('design.installation.marks.show')}
                            </Button>
                          ) : null}
                          {tool.canEdit ? (
                            <Button
                              variant="outline"
                              aria-label={t('design.installation.marks.withdrawLabel', {
                                route: ltr(mark.routeHandle),
                              })}
                              disabled={tool.withdrawingId !== null}
                              onClick={() => tool.withdraw(mark.id)}
                            >
                              {tool.withdrawingId === mark.id
                                ? t('design.installation.marks.withdrawing')
                                : t('design.installation.marks.withdraw')}
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </>
      )}
    </section>
  );
}
