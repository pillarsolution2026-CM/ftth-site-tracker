'use client';

import Link from 'next/link';
import type { AsBuiltEdit } from '@ftth/shared';
import { ErrorNotice } from '@/shared/ui/error-notice';
import { Ltr } from '@/shared/ui/ltr';
import { Pagination } from '@/shared/ui/pagination';
import { Select } from '@/shared/ui/form-controls';
import { PageHeader, Table, Td, Th } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import { formatDateTime } from '@/shared/lib/format';
import { type ClientErrorCode } from '@/shared/api/bff-client';
import { useEditList } from '../hooks/use-edit-list';
import { formatLengthM } from '../model/length';
import {
  FEATURE_TYPE_LABEL,
  FILTER_LABEL,
  KIND_LABEL,
  STATUS_FILTERS,
  isStatusFilter,
  type StatusFilter,
} from '../model/review-model';
import { EditStatusBadge } from './edit-status-badge';
import { ExportsPanel } from './exports-panel';
import { FlagList } from './flag-list';

interface EditListViewProps {
  basePath: string;
  items: AsBuiltEdit[] | null;
  total: number;
  page: number;
  pageSize: number;
  filter: StatusFilter;
  errorCode: ClientErrorCode | null;
  onFilterChange: (filter: StatusFilter) => void;
  onPageChange: (page: number) => void;
}

export function EditListView({
  basePath,
  items,
  total,
  page,
  pageSize,
  filter,
  errorCode,
  onFilterChange,
  onPageChange,
}: EditListViewProps) {
  const { t, locale } = useI18n();
  return (
    <div className="flex flex-col gap-4">
      <PageHeader className="mb-0">
        <h1 className="text-xl font-semibold">{t('asbuiltReview.listTitle')}</h1>
        <Select
          id="asbuilt-status-filter"
          label={t('asbuiltReview.filter.label')}
          value={filter}
          onChange={(event) => {
            if (isStatusFilter(event.target.value)) onFilterChange(event.target.value);
          }}
        >
          {STATUS_FILTERS.map((value) => (
            <option key={value} value={value}>
              {t(FILTER_LABEL[value])}
            </option>
          ))}
        </Select>
      </PageHeader>
      {errorCode ? <ErrorNotice code={errorCode} /> : null}
      {!errorCode && items === null ? <p role="status">{t('common.loading')}</p> : null}
      {items && items.length === 0 ? <p>{t('asbuiltReview.empty')}</p> : null}
      {items && items.length > 0 ? (
        <div>
          <Table aria-label={t('asbuiltReview.listTitle')}>
            <thead>
              <tr>
                <Th>{t('asbuiltReview.columns.received')}</Th>
                <Th>{t('asbuiltReview.columns.supervisor')}</Th>
                <Th>{t('asbuiltReview.columns.tool')}</Th>
                <Th>{t('asbuiltReview.columns.featureType')}</Th>
                <Th>{t('asbuiltReview.columns.flags')}</Th>
                <Th>{t('asbuiltReview.columns.length')}</Th>
                <Th>{t('asbuiltReview.columns.status')}</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((edit) => (
                <tr key={edit.id}>
                  <Td>
                    <Link
                      href={`${basePath}/${edit.id}`}
                      className="inline-flex min-h-11 items-center text-(--color-brand) underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)"
                    >
                      <Ltr>{formatDateTime(edit.receivedAt, locale)}</Ltr>
                    </Link>
                  </Td>
                  <Td>{edit.userName}</Td>
                  <Td>{t(KIND_LABEL[edit.kind])}</Td>
                  <Td>{t(FEATURE_TYPE_LABEL[edit.featureType])}</Td>
                  <Td>
                    <FlagList flags={edit.flags} />
                  </Td>
                  <Td>
                    {edit.lengthM !== null ? <Ltr>{formatLengthM(edit.lengthM, locale)}</Ltr> : '—'}
                  </Td>
                  <Td>
                    <EditStatusBadge status={edit.status} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Pagination page={page} pageSize={pageSize} total={total} onPageChange={onPageChange} />
        </div>
      ) : null}
    </div>
  );
}

export function EditList({ projectId }: { projectId: string }) {
  const { locale } = useI18n();
  const state = useEditList(projectId);
  return (
    <div className="flex flex-col gap-6">
      <EditListView
        basePath={`/${locale}/projects/${projectId}/asbuilt`}
        items={state.canRead ? state.items : []}
        total={state.total}
        page={state.page}
        pageSize={state.pageSize}
        filter={state.filter}
        errorCode={!state.canRead ? 'FORBIDDEN' : state.errorCode}
        onFilterChange={state.changeFilter}
        onPageChange={state.changePage}
      />
      <ExportsPanel projectId={projectId} />
    </div>
  );
}
