import type { ImportPreviewRow } from '@ftth/shared';
import { hasErrors, hasWarnings } from './import-wizard';

export const ROW_FILTERS = ['all', 'errors', 'warnings', 'excluded'] as const;
export type RowFilter = (typeof ROW_FILTERS)[number];

export const ROWS_PER_PAGE = 100;

export function filterRows(
  rows: readonly ImportPreviewRow[],
  filter: RowFilter,
  excluded: ReadonlySet<number>,
): ImportPreviewRow[] {
  switch (filter) {
    case 'all':
      return [...rows];
    case 'errors':
      return rows.filter(hasErrors);
    case 'warnings':
      return rows.filter(hasWarnings);
    case 'excluded':
      return rows.filter((row) => excluded.has(row.rowNumber));
  }
}
