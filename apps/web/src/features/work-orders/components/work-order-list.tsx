'use client';

import Link from 'next/link';
import type { WorkOrderSummary } from '@ftth/shared';
import { Ltr } from '@/shared/ui/ltr';
import { ErrorNotice } from '@/shared/ui/error-notice';
import { PageHeader, Table, Td, Th } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import { formatMoney } from '@/shared/lib/decimal';
import { errorCodeOf, type ClientErrorCode } from '@/shared/api/bff-client';
import { useProject } from '@/features/projects/hooks/project-access-context';
import { useWorkOrders } from '../api/queries';

interface WorkOrderListViewProps {
  basePath: string;
  items: WorkOrderSummary[] | null;
  errorCode: ClientErrorCode | null;
  canWrite: boolean;
}

const LINK =
  'inline-flex min-h-11 items-center justify-center rounded-md border px-4 font-semibold ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)';

export function WorkOrderListView({
  basePath,
  items,
  errorCode,
  canWrite,
}: WorkOrderListViewProps) {
  const { t, locale } = useI18n();
  return (
    <div>
      <PageHeader>
        <h1 className="text-xl font-semibold">{t('workOrders.listTitle')}</h1>
        {canWrite ? (
          <div className="flex flex-wrap gap-2">
            <Link
              href={`${basePath}/new`}
              className={`${LINK} border-transparent bg-(--color-brand) text-(--color-brandContrast)`}
            >
              {t('workOrders.new')}
            </Link>
            <Link
              href={`${basePath}/import`}
              className={`${LINK} border-(--color-brand) text-(--color-brand)`}
            >
              {t('workOrders.importExcel')}
            </Link>
          </div>
        ) : null}
      </PageHeader>
      {errorCode ? <ErrorNotice code={errorCode} /> : null}
      {!errorCode && items === null ? <p role="status">{t('common.loading')}</p> : null}
      {items && items.length === 0 ? <p>{t('workOrders.empty')}</p> : null}
      {items && items.length > 0 ? (
        <Table aria-label={t('workOrders.listTitle')}>
          <thead>
            <tr>
              <Th>{t('workOrders.number')}</Th>
              <Th>{t('workOrders.title')}</Th>
              <Th>{t('workOrders.issuedOn')}</Th>
              <Th>{t('workOrders.source')}</Th>
              <Th>{t('workOrders.itemCount')}</Th>
              <Th>{t('workOrders.total')}</Th>
            </tr>
          </thead>
          <tbody>
            {items.map((workOrder) => (
              <tr key={workOrder.id}>
                <Td>
                  <Link
                    href={`${basePath}/${workOrder.id}`}
                    className="inline-flex min-h-11 items-center text-(--color-brand) underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)"
                  >
                    <Ltr>{workOrder.number}</Ltr>
                  </Link>
                </Td>
                <Td>{workOrder.title ?? '—'}</Td>
                <Td>{workOrder.issuedOn ? <Ltr>{workOrder.issuedOn}</Ltr> : '—'}</Td>
                <Td>{t(`workOrders.sources.${workOrder.source}`)}</Td>
                <Td>
                  <Ltr>{workOrder.itemCount}</Ltr>
                </Td>
                <Td>
                  <Ltr>{formatMoney(workOrder.total, workOrder.currency, locale)}</Ltr>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}
    </div>
  );
}

export function WorkOrderList({ projectId }: { projectId: string }) {
  const { locale } = useI18n();
  const { can } = useProject();
  const canRead = can('work_orders:read');
  const query = useWorkOrders(projectId, canRead);
  return (
    <WorkOrderListView
      basePath={`/${locale}/projects/${projectId}/work-orders`}
      items={canRead ? (query.data?.items ?? null) : []}
      errorCode={!canRead ? 'FORBIDDEN' : query.error ? errorCodeOf(query.error) : null}
      canWrite={can('work_orders:write')}
    />
  );
}
