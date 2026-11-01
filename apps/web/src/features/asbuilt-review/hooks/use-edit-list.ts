'use client';

import { useState } from 'react';
import { errorCodeOf } from '@/shared/api/bff-client';
import { useProject } from '@/features/projects/hooks/project-access-context';
import { useAsBuiltEdits } from '../api/queries';
import {
  DEFAULT_STATUS_FILTER,
  EDITS_PAGE_SIZE,
  listQuery,
  type StatusFilter,
} from '../model/review-model';

/** List screen state: status filter (default pending) and the limit/offset page. */
export function useEditList(projectId: string) {
  const { can } = useProject();
  const canRead = can('asbuilt:read');
  const [filter, setFilter] = useState<StatusFilter>(DEFAULT_STATUS_FILTER);
  const [page, setPage] = useState(1);
  const query = useAsBuiltEdits(projectId, listQuery(filter, page), canRead);
  return {
    canRead,
    filter,
    page,
    pageSize: EDITS_PAGE_SIZE,
    items: query.data?.items ?? null,
    total: query.data?.total ?? 0,
    errorCode: query.error ? errorCodeOf(query.error) : null,
    changeFilter: (next: StatusFilter) => {
      setFilter(next);
      setPage(1);
    },
    changePage: setPage,
  };
}
