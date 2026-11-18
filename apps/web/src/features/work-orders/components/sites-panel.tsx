'use client';

import { Button } from '@/shared/ui/button';
import { ErrorNotice } from '@/shared/ui/error-notice';
import { Input } from '@/shared/ui/input';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import { useSitesEditor } from '../hooks/use-sites-editor';

/** The sites of the work order (ADR-049): typed one by one, or read from a table, then saved. */
export function SitesPanel({
  projectId,
  workOrderId,
  version,
  canWrite,
}: {
  projectId: string;
  workOrderId: string;
  version: number;
  canWrite: boolean;
}) {
  const { t } = useI18n();
  const s = useSitesEditor(projectId, workOrderId, version);

  return (
    <section aria-labelledby="sites-title" className="mt-8">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 id="sites-title" className="text-lg font-semibold">
          {t('sites.title')}{' '}
          <span className="text-sm font-normal opacity-80">
            (<Ltr>{s.saved.length}</Ltr>)
          </span>
        </h2>
        {canWrite && !s.editing ? (
          <Button variant="outline" onClick={s.start}>
            {t('sites.edit')}
          </Button>
        ) : null}
      </div>
      {s.loadErrorCode ? <ErrorNotice code={s.loadErrorCode} className="mb-2" /> : null}
      {s.loading ? <p role="status">{t('common.loading')}</p> : null}

      {!s.editing ? (
        s.saved.length === 0 && !s.loading ? (
          <p>{t('sites.empty')}</p>
        ) : (
          <ol className="list-decimal divide-y divide-(--color-border) rounded-md border border-(--color-border) ps-8">
            {s.saved.map((site) => (
              <li key={site.id} className="px-3 py-2">
                {site.name}
              </li>
            ))}
          </ol>
        )
      ) : (
        <div className="flex flex-col gap-3">
          {s.conflict ? (
            <Notice kind="warning">
              <p>{t('workOrders.conflictOnUpdate')}</p>
              <Button variant="outline" className="mt-2" onClick={() => void s.reload()}>
                {t('workOrders.reload')}
              </Button>
            </Notice>
          ) : s.saveErrorCode ? (
            <ErrorNotice code={s.saveErrorCode} />
          ) : null}
          {s.tooMany ? <Notice kind="error">{t('sites.tooMany')}</Notice> : null}

          <div className="flex flex-col gap-1">
            <label htmlFor="sites-table" className="text-sm font-medium">
              {t('sites.uploadTable')}
            </label>
            <p className="text-sm opacity-80">{t('sites.uploadHint')}</p>
            <input
              id="sites-table"
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              disabled={s.readingTable}
              onChange={(event) => void s.onTableFile(event)}
              className="min-h-11 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)"
            />
            {s.readingTable ? <p role="status">{t('sites.readingTable')}</p> : null}
            {s.tableErrorCode ? <ErrorNotice code={s.tableErrorCode} /> : null}
            {s.tableNote ? (
              <Notice kind="info">
                {t('sites.tableAdded', { added: s.tableNote.added, skipped: s.tableNote.skipped })}
              </Notice>
            ) : null}
          </div>

          <ol className="flex flex-col gap-2">
            {s.rows.map((row, index) => {
              const error = s.errors[row.key];
              return (
                <li key={row.key} className="flex items-end gap-2">
                  <div className="flex-1">
                    <Input
                      id={`site-${row.key}`}
                      label={t('sites.nameOf', { n: index + 1 })}
                      value={row.name}
                      onChange={s.onRename(row.key)}
                      error={error ? t(error) : undefined}
                    />
                  </div>
                  <Button
                    variant="outline"
                    aria-label={`${t('common.delete')} ${row.name || index + 1}`}
                    onClick={() => s.onRemove(row.key)}
                  >
                    {t('common.delete')}
                  </Button>
                </li>
              );
            })}
          </ol>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={s.onAdd}>
              {t('sites.add')}
            </Button>
            <Button disabled={s.saving || !s.changed} onClick={() => void s.save()}>
              {s.saving ? t('common.saving') : t('common.save')}
            </Button>
            <Button variant="outline" onClick={s.cancel}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
