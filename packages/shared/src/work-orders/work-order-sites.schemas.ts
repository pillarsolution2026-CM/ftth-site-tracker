import { z } from 'zod';

/** Longest site name (technical limit, ADR-049). */
export const SITE_NAME_MAX_LENGTH = 200;
/** Most sites on one work order (technical limit, ADR-049). */
export const MAX_WORK_ORDER_SITES = 500;

/**
 * Key used to compare site names (ADR-049): trim, collapse whitespace, lower-case, strip Arabic
 * diacritics and tatweel, unify أ/إ/آ→ا, ة→ه, ى→ي. The name is stored and shown as typed; only the
 * key is compared, so «ام شيحان» and «أم  شيحان» are one site. Returns null for an empty name.
 */
export function siteKeyOf(name: string | null | undefined): string | null {
  if (name === null || name === undefined) return null;
  const key = name
    .normalize('NFC')
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return key === '' ? null : key;
}

/** Names that occur more than once (compared by `siteKeyOf`), as first written. */
export function repeatedSiteNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated: string[] = [];
  for (const name of names) {
    const key = siteKeyOf(name);
    if (key === null) continue;
    if (seen.has(key) && !repeated.some((other) => siteKeyOf(other) === key)) repeated.push(name);
    seen.add(key);
  }
  return repeated;
}

const SiteNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(SITE_NAME_MAX_LENGTH)
  .transform((name) => name.replace(/\s+/g, ' '));

/** One site in a replace request: with `id` an existing site (kept or renamed), without it a new one. */
export const WorkOrderSiteInputSchema = z.strictObject({
  id: z.uuid().optional(),
  name: SiteNameSchema,
});
export type WorkOrderSiteInput = z.infer<typeof WorkOrderSiteInputSchema>;

/**
 * PUT /projects/:projectId/work-orders/:workOrderId/sites (`work_orders:write`). The list replaces
 * the sites of the work order, in this order. Sites missing from the list are removed.
 */
export const ReplaceWorkOrderSitesRequestSchema = z
  .strictObject({
    /** Optimistic concurrency: must equal the work order's current `version`, else CONFLICT. */
    expectedVersion: z.number().int().min(1),
    sites: z.array(WorkOrderSiteInputSchema).max(MAX_WORK_ORDER_SITES),
  })
  .superRefine((request, ctx) => {
    const repeated = repeatedSiteNames(request.sites.map((site) => site.name));
    if (repeated.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['sites'],
        message: `A site may appear only once: ${repeated.join(', ')}`,
      });
    }
    const ids = request.sites.flatMap((site) => (site.id ? [site.id] : []));
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', path: ['sites'], message: 'A site id may appear only once' });
    }
  });
export type ReplaceWorkOrderSitesRequest = z.infer<typeof ReplaceWorkOrderSitesRequestSchema>;

/**
 * `details.reason` of 409 CONFLICT from the sites endpoint:
 * - SITE_NOT_FOUND: an `id` is not a site of this work order (details carry `siteId`).
 * - VERSION_MISMATCH: the work order was changed by someone else (details carry `currentVersion`).
 */
export const WORK_ORDER_SITE_CONFLICT_REASONS = ['SITE_NOT_FOUND', 'VERSION_MISMATCH'] as const;

export const WorkOrderSiteSchema = z.object({
  id: z.uuid(),
  workOrderId: z.uuid(),
  name: z.string(),
  /** 1..n, the order of the list. */
  position: z.number().int().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type WorkOrderSite = z.infer<typeof WorkOrderSiteSchema>;

/** GET and PUT …/sites. `version` is the work order's version after the call. */
export const WorkOrderSiteListResponseSchema = z.object({
  version: z.number().int().min(1),
  items: z.array(WorkOrderSiteSchema),
});
export type WorkOrderSiteListResponse = z.infer<typeof WorkOrderSiteListResponseSchema>;

/** Header texts of the first row that are skipped when reading a sites table (compared by key). */
export const SITE_TABLE_HEADERS = [
  'اسم الموقع',
  'الموقع',
  'المواقع',
  'اسماء المواقع',
  'site',
  'sites',
  'site name',
] as const;

/**
 * POST …/sites/preview (`work_orders:write`, multipart field `file`, `.xlsx`). Reads the names of the
 * first column that has text in the first sheet; nothing is saved.
 */
export const WorkOrderSitesPreviewResponseSchema = z.object({
  sheetName: z.string(),
  /** Names in table order, spaces collapsed, repeats removed (first kept). */
  names: z.array(z.string()),
  /** Names dropped because they repeat an earlier row. */
  repeated: z.array(z.string()),
  /** Rows longer than SITE_NAME_MAX_LENGTH, by Excel row number. */
  tooLongRows: z.array(z.number().int().min(1)),
});
export type WorkOrderSitesPreviewResponse = z.infer<typeof WorkOrderSitesPreviewResponseSchema>;

/**
 * Names from the cells of one column, top to bottom (`null` = empty cell): skips a header row and
 * empty cells, collapses spaces, drops repeats. Shared by the API reader and its tests.
 */
export function siteNamesFromColumn(cells: readonly { row: number; text: string | null }[]): {
  names: string[];
  repeated: string[];
  tooLongRows: number[];
} {
  const headerKeys = new Set(SITE_TABLE_HEADERS.map((header) => siteKeyOf(header)));
  const names: string[] = [];
  const repeated: string[] = [];
  const tooLongRows: number[] = [];
  const seen = new Set<string>();
  let first = true;
  for (const cell of cells) {
    const name = (cell.text ?? '').replace(/\s+/g, ' ').trim();
    const key = siteKeyOf(name);
    if (key === null) continue;
    if (first) {
      first = false;
      if (headerKeys.has(key)) continue;
    }
    if (name.length > SITE_NAME_MAX_LENGTH) {
      tooLongRows.push(cell.row);
      continue;
    }
    if (seen.has(key)) {
      repeated.push(name);
      continue;
    }
    seen.add(key);
    names.push(name);
  }
  return { names, repeated, tooLongRows };
}
