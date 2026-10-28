'use client';

import Link from 'next/link';
import type { DesignRevisionSummary } from '@ftth/shared';
import { Ltr } from '@/shared/ui/ltr';
import { ErrorNotice } from '@/shared/ui/error-notice';
import { PageHeader, Table, Td, Th } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import { formatDateTime } from '@/shared/lib/format';
import { errorCodeOf, type ClientErrorCode } from '@/shared/api/bff-client';
import { useProject } from '@/features/projects/hooks/project-access-context';
import { useDesignRevisions } from '../api/queries';
import { RevisionStatusBadge } from './revision-status-badge';

interface DesignRevisionListViewProps {
  basePath: string;
  revisions: DesignRevisionSummary[] | null;
  errorCode: ClientErrorCode | null;
}

export function DesignRevisionListView({
  basePath,
  revisions,
  errorCode,
}: DesignRevisionListViewProps) {
  const { t, locale } = useI18n();
  return (
    <div>
      <PageHeader>
        <h1 className="text-xl font-semibold">{t('design.listTitle')}</h1>
      </PageHeader>
      {errorCode ? <ErrorNotice code={errorCode} /> : null}
      {!errorCode && revisions === null ? <p role="status">{t('common.loading')}</p> : null}
      {revisions && revisions.length === 0 ? <p>{t('design.empty')}</p> : null}
      {revisions && revisions.length > 0 ? (
        <Table aria-label={t('design.listTitle')}>
          <thead>
            <tr>
              <Th>{t('design.revision')}</Th>
              <Th>{t('cad.statusLabel')}</Th>
              <Th>{t('design.file')}</Th>
              <Th>{t('design.crs')}</Th>
              <Th>{t('design.unit')}</Th>
              <Th>{t('design.createdAt')}</Th>
            </tr>
          </thead>
          <tbody>
            {revisions.map((revision) => (
              <tr key={revision.id}>
                <Td>
                  <Link
                    href={`${basePath}/${revision.id}`}
                    className="inline-flex min-h-11 items-center text-(--color-brand) underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)"
                  >
                    {revision.revNo !== null ? (
                      <Ltr>#{revision.revNo}</Ltr>
                    ) : (
                      t('design.draftLabel')
                    )}
                  </Link>
                </Td>
                <Td>
                  <RevisionStatusBadge status={revision.status} />
                  {revision.status === 'failed' && revision.errorCode ? (
                    <p className="mt-1 text-sm">{t(`design.failure.${revision.errorCode}`)}</p>
                  ) : null}
                </Td>
                <Td>
                  <Ltr className="break-all">{revision.cadFileName}</Ltr>
                </Td>
                <Td>
                  <Ltr>{revision.crsEpsg}</Ltr>
                </Td>
                <Td>
                  <span className="inline-flex flex-wrap items-center gap-1">
                    <Ltr>{revision.drawingUnit}</Ltr>
                    {revision.unitsConflict ? (
                      <span title={t('mapping.warning.title')}>
                        <span aria-hidden="true">▲</span>
                        <span className="sr-only">{t('mapping.warning.title')}</span>
                      </span>
                    ) : null}
                  </span>
                </Td>
                <Td>
                  <Ltr>{formatDateTime(revision.createdAt, locale)}</Ltr>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}
    </div>
  );
}

export function DesignRevisionList({ projectId }: { projectId: string }) {
  const { locale } = useI18n();
  const { can } = useProject();
  const canRead = can('design:read');
  const query = useDesignRevisions(projectId, canRead);
  return (
    <DesignRevisionListView
      basePath={`/${locale}/projects/${projectId}/design-revisions`}
      revisions={canRead ? (query.data?.items ?? null) : []}
      errorCode={!canRead ? 'FORBIDDEN' : query.error ? errorCodeOf(query.error) : null}
    />
  );
}
