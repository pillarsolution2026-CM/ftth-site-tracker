import type { MessageKey } from '@ftth/i18n';
import {
  MAX_WORK_ORDER_SITES,
  SITE_NAME_MAX_LENGTH,
  siteKeyOf,
  type ReplaceWorkOrderSitesRequest,
  type WorkOrderSite,
} from '@ftth/shared';

/** One row of the sites editor (ADR-049). `id` is set for a saved site, `key` is the React key. */
export interface SiteRow {
  key: string;
  id: string | null;
  name: string;
}

let rowCounter = 0;
const newKey = () => `new-${++rowCounter}`;

export const rowsFromSites = (sites: readonly Pick<WorkOrderSite, 'id' | 'name'>[]): SiteRow[] =>
  sites.map((site) => ({ key: site.id, id: site.id, name: site.name }));

export const addRow = (rows: readonly SiteRow[], name = ''): SiteRow[] => [
  ...rows,
  { key: newKey(), id: null, name },
];

export const removeRow = (rows: readonly SiteRow[], key: string): SiteRow[] =>
  rows.filter((row) => row.key !== key);

export const renameRow = (rows: readonly SiteRow[], key: string, name: string): SiteRow[] =>
  rows.map((row) => (row.key === key ? { ...row, name } : row));

/**
 * Adds the names read from a table after the current rows. Names already in the list (same key)
 * are not added again; empty rows typed but not filled are dropped first. Returns how many were
 * skipped as already present.
 */
export function mergeTableNames(
  rows: readonly SiteRow[],
  names: readonly string[],
): { rows: SiteRow[]; skipped: number } {
  const kept = rows.filter((row) => siteKeyOf(row.name) !== null || row.id !== null);
  const keys = new Set(kept.map((row) => siteKeyOf(row.name)));
  let next = [...kept];
  let skipped = 0;
  for (const name of names) {
    const key = siteKeyOf(name);
    if (key === null) continue;
    if (keys.has(key)) {
      skipped += 1;
      continue;
    }
    keys.add(key);
    next = addRow(next, name);
  }
  return { rows: next, skipped };
}

export type SiteRowErrors = Record<string, MessageKey>;

/** Per-row errors: empty, too long, or a repeat of an earlier row (same comparison as the API). */
export function validateRows(rows: readonly SiteRow[]): SiteRowErrors {
  const errors: SiteRowErrors = {};
  const seen = new Set<string>();
  for (const row of rows) {
    const key = siteKeyOf(row.name);
    if (key === null) errors[row.key] = 'validation.required';
    else if (row.name.trim().length > SITE_NAME_MAX_LENGTH) errors[row.key] = 'validation.tooLong';
    else if (seen.has(key)) errors[row.key] = 'sites.repeated';
    if (key !== null) seen.add(key);
  }
  return errors;
}

export const tooManyRows = (rows: readonly SiteRow[]) => rows.length > MAX_WORK_ORDER_SITES;

export function sitesPayload(
  rows: readonly SiteRow[],
  expectedVersion: number,
): ReplaceWorkOrderSitesRequest {
  return {
    expectedVersion,
    sites: rows.map((row) => ({
      ...(row.id ? { id: row.id } : {}),
      name: row.name.trim().replace(/\s+/g, ' '),
    })),
  };
}

/** True when the rows differ from the saved sites (names or order). */
export function rowsChanged(
  rows: readonly SiteRow[],
  saved: readonly Pick<WorkOrderSite, 'id' | 'name'>[],
): boolean {
  if (rows.length !== saved.length) return true;
  return rows.some((row, index) => row.id !== saved[index]?.id || row.name !== saved[index]?.name);
}
