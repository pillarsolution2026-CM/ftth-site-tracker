'use client';

import type { AsBuiltExport } from '@ftth/shared';
import { Button } from '@/shared/ui/button';
import { Card } from '@/shared/ui/card';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { Table, Td, Th } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import { formatBytes, formatDateTime } from '@/shared/lib/format';
import { useExports } from '../hooks/use-exports';
import { ExportStatusBadge } from './edit-status-badge';
import type { MessageKey } from '@ftth/i18n';

export interface ExportsPanelViewProps {
  items: AsBuiltExport[] | null;
  running: boolean;
  requesting: boolean;
  errorKey: MessageKey | null;
  onRequest: () => void;
  fileUrl: (id: string) => string;
}

export function ExportsPanelView({
  items,
  running,
  requesting,
  errorKey,
  onRequest,
  fileUrl,
}: ExportsPanelViewProps) {
  const { t, locale } = useI18n();
  return (
    <Card>
      <section aria-labelledby="asbuilt-exports-title" className="flex flex-col gap-3">
        <h2 id="asbuilt-exports-title" className="text-lg font-semibold">
          {t('asbuiltReview.exports.title')}
        </h2>
        <div>
          <Button onClick={onRequest} disabled={requesting}>
            {requesting
              ? t('asbuiltReview.exports.requesting')
              : t('asbuiltReview.exports.request')}
          </Button>
        </div>
        {errorKey ? <Notice kind="error">{t(errorKey)}</Notice> : null}
        {running ? <p aria-live="polite">{t('asbuiltReview.exports.autoRefresh')}</p> : null}
        {items && items.length === 0 ? <p>{t('asbuiltReview.exports.empty')}</p> : null}
        {items && items.length > 0 ? (
          <Table aria-label={t('asbuiltReview.exports.title')}>
            <thead>
              <tr>
                <Th>{t('asbuiltReview.exports.requestedAt')}</Th>
                <Th>{t('asbuiltReview.columns.status')}</Th>
                <Th>{t('asbuiltReview.exports.size')}</Th>
                <Th>{t('common.actions')}</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <Td>
                    <Ltr>{formatDateTime(item.requestedAt, locale)}</Ltr>
                  </Td>
                  <Td>
                    <ExportStatusBadge status={item.status} />
                    {item.status === 'failed' && item.error ? (
                      <p className="mt-1 text-sm">
                        {t('asbuiltReview.exports.errorCode')}: <Ltr>{item.error}</Ltr>
                      </p>
                    ) : null}
                    {item.status === 'done' && item.stats ? (
                      <p className="mt-1 text-sm">
                        {t('asbuiltReview.exports.stats', {
                          design: item.stats.designFeatures,
                          edited: item.stats.editedFeatures,
                          added: item.stats.addedFeatures,
                        })}
                      </p>
                    ) : null}
                  </Td>
                  <Td>
                    {item.sizeBytes !== null ? <Ltr>{formatBytes(item.sizeBytes)}</Ltr> : null}
                  </Td>
                  <Td>
                    {item.status === 'done' ? (
                      <a
                        href={fileUrl(item.id)}
                        download
                        className="inline-flex min-h-11 items-center text-(--color-brand) underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)"
                      >
                        {t('asbuiltReview.exports.download')}
                      </a>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : null}
      </section>
    </Card>
  );
}

/** Shown only to users with `asbuilt:export`. */
export function ExportsPanel({ projectId }: { projectId: string }) {
  const state = useExports(projectId);
  if (!state.canExport) return null;
  return (
    <ExportsPanelView
      items={state.items}
      running={state.running}
      requesting={state.requesting}
      errorKey={state.errorKey}
      onRequest={state.requestExport}
      fileUrl={state.fileUrl}
    />
  );
}
