import type { DrawingKind } from '@ftth/shared';

/** A drawing of a site (ADR-049 part B): a line of file versions of one kind. */
export interface SiteDrawingRecord {
  id: string;
  projectId: string;
  /** null only for drawings from before sites that are not linked yet («بدون موقع»). */
  siteId: string | null;
  kind: DrawingKind;
  /** General 1; Secondary 1, 2, … per site; withdrawn drawings keep their number. */
  ordinal: number;
  withdrawnAt: Date | null;
  withdrawnById: string | null;
  createdById: string | null;
  createdAt: Date;
}

/** A drawing with what the list shows: its current file and its newest revisions. */
export interface SiteDrawingState extends SiteDrawingRecord {
  currentFile: { id: string; originalName: string } | null;
  openRevision: { id: string; status: 'queued' | 'building' | 'draft' } | null;
  latestPublished: { id: string; revNo: number; publishedAt: Date } | null;
}

export const isActive = (drawing: SiteDrawingRecord): boolean => drawing.withdrawnAt === null;

/** General first, then the Secondaries by number. */
export function sortDrawings<T extends { kind: DrawingKind; ordinal: number }>(
  drawings: readonly T[],
): T[] {
  const rank = (kind: DrawingKind) => (kind === 'general' ? 0 : 1);
  return [...drawings].sort((a, b) => rank(a.kind) - rank(b.kind) || a.ordinal - b.ordinal);
}

/** The number of the next drawing of the kind in a site (withdrawn ones keep theirs). */
export function nextOrdinal(drawings: readonly SiteDrawingRecord[], kind: DrawingKind): number {
  if (kind === 'general') return 1;
  return Math.max(0, ...drawings.filter((d) => d.kind === kind).map((d) => d.ordinal)) + 1;
}

/** The kinds a site still lacks: it publishes only with its General and a Secondary (SITE_INCOMPLETE). */
export function missingKinds(drawings: readonly SiteDrawingRecord[]): DrawingKind[] {
  const active = drawings.filter(isActive);
  const missing: DrawingKind[] = [];
  if (!active.some((d) => d.kind === 'general')) missing.push('general');
  if (!active.some((d) => d.kind === 'secondary')) missing.push('secondary');
  return missing;
}
