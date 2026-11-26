'use client';

import { useState } from 'react';
import { errorCodeOf } from '@/shared/api/bff-client';
import { useProject } from '@/features/projects/hooks/project-access-context';
import { useUpdates } from '../api/queries';
import { listQuery, UPDATES_PAGE_SIZE, type StatusFilter } from '../model/update-list-model';

/** List screen state: status and site filters and the limit/offset page. */
export function useUpdateList(projectId: string) {
  const { can } = useProject();
  const canRead = can('execution:read');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [siteId, setSiteId] = useState('');
  const [page, setPage] = useState(1);
  const query = useUpdates(projectId, listQuery(status, siteId, page), canRead);
  return {
    canRead,
    status,
    siteId,
    page,
    pageSize: UPDATES_PAGE_SIZE,
    items: query.data?.items ?? null,
    total: query.data?.total ?? 0,
    sites: query.data?.sites ?? [],
    errorCode: query.error ? errorCodeOf(query.error) : null,
    changeStatus: (next: StatusFilter) => {
      setStatus(next);
      setPage(1);
    },
    changeSite: (next: string) => {
      setSiteId(next);
      setPage(1);
    },
    changePage: setPage,
  };
}
