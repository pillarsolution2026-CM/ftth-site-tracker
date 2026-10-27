'use client';

import { useMemo, useState } from 'react';
import type { ImportPreviewRow } from '@ftth/shared';
import { filterRows, ROWS_PER_PAGE, type RowFilter } from '../model/rows-filter';

/** Filter + client-side paging of the preview rows (a sheet can have thousands). */
export function useRowsView(rows: readonly ImportPreviewRow[], excluded: ReadonlySet<number>) {
  const [filter, setFilterState] = useState<RowFilter>('all');
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => filterRows(rows, filter, excluded), [rows, filter, excluded]);
  const pages = Math.max(1, Math.ceil(filtered.length / ROWS_PER_PAGE));
  const current = Math.min(page, pages);
  const visible = filtered.slice((current - 1) * ROWS_PER_PAGE, current * ROWS_PER_PAGE);

  return {
    filter,
    setFilter: (next: RowFilter) => {
      setFilterState(next);
      setPage(1);
    },
    page: current,
    setPage,
    filteredCount: filtered.length,
    visible,
  };
}
