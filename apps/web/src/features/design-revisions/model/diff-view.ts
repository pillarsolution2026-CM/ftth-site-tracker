import type { DiffChange } from '@ftth/shared';

export const DIFF_PAGE_SIZE = 50;

export interface DiffFilter {
  change: DiffChange | 'all';
  changedOnly: boolean;
}

/** The diff opens on what changed; `unchanged` rows are hidden unless asked for. */
export const DEFAULT_DIFF_FILTER: DiffFilter = { change: 'all', changedOnly: true };

/** Choosing one specific change (even `unchanged`) overrides "changed only". */
export function diffQuery(filter: DiffFilter, page: number) {
  return {
    page,
    pageSize: DIFF_PAGE_SIZE,
    ...(filter.change !== 'all' ? { change: filter.change } : {}),
    changedOnly: filter.change === 'all' ? filter.changedOnly : false,
  };
}
