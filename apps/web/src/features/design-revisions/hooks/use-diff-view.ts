'use client';

import { useState } from 'react';
import { errorCodeOf } from '@/shared/api/bff-client';
import { useDiff } from '../api/queries';
import { DEFAULT_DIFF_FILTER, diffQuery, type DiffFilter } from '../model/diff-view';

/** Diff table: changed rows only by default, filter by change, paging. */
export function useDiffView(projectId: string, revisionId: string, enabled: boolean) {
  const [filter, setFilterState] = useState<DiffFilter>(DEFAULT_DIFF_FILTER);
  const [page, setPage] = useState(1);
  const diff = useDiff(projectId, revisionId, diffQuery(filter, page), enabled);
  return {
    filter,
    setFilter: (next: DiffFilter) => {
      setFilterState(next);
      setPage(1);
    },
    page,
    setPage,
    items: diff.data?.items ?? null,
    total: diff.data?.total ?? 0,
    pageSize: diff.data?.pageSize ?? 0,
    errorCode: diff.error ? errorCodeOf(diff.error) : null,
  };
}
