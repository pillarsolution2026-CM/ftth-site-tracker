import type { MessageKey } from '@ftth/i18n';
import type { DrawingKind, UpdateFlag, UpdateListQuery, UpdateStatus } from '@ftth/shared';

export const UPDATES_PAGE_SIZE = 20;

export type StatusFilter = UpdateStatus | 'all';
export const STATUS_FILTERS: readonly StatusFilter[] = ['all', 'pending', 'approved', 'rejected'];

export function isStatusFilter(value: string): value is StatusFilter {
  return (STATUS_FILTERS as readonly string[]).includes(value);
}

export const FILTER_LABEL: Record<StatusFilter, MessageKey> = {
  all: 'updatesList.filter.all',
  pending: 'updatesList.status.pending',
  approved: 'updatesList.status.approved',
  rejected: 'updatesList.status.rejected',
};

export const STATUS_LABEL: Record<UpdateStatus, MessageKey> = {
  pending: 'updatesList.status.pending',
  approved: 'updatesList.status.approved',
  rejected: 'updatesList.status.rejected',
};

/** Status is a mark and a word, never colour alone. */
export const STATUS_ICON: Record<UpdateStatus, string> = {
  pending: '…',
  approved: '✓',
  rejected: '✕',
};

export const FLAG_LABEL: Record<UpdateFlag, MessageKey> = {
  CLOCK_AHEAD: 'updatesList.flags.CLOCK_AHEAD',
  CLOCK_BEHIND: 'updatesList.flags.CLOCK_BEHIND',
  GPS_FAR: 'updatesList.flags.GPS_FAR',
  GPS_MISSING: 'updatesList.flags.GPS_MISSING',
  ITEM_OVERRUN: 'updatesList.flags.ITEM_OVERRUN',
  REVISION_OUTDATED: 'updatesList.flags.REVISION_OUTDATED',
  FEATURE_REMOVED: 'updatesList.flags.FEATURE_REMOVED',
};

/** Query of the list endpoint: `all` leaves the status out, an empty site leaves the site out. */
export function listQuery(
  status: StatusFilter,
  siteId: string,
  page: number,
): Partial<UpdateListQuery> & { limit: number; offset: number } {
  return {
    ...(status === 'all' ? {} : { status }),
    ...(siteId ? { siteId } : {}),
    limit: UPDATES_PAGE_SIZE,
    offset: (Math.max(page, 1) - 1) * UPDATES_PAGE_SIZE,
  };
}

/** «General» or «Secondary n» (ADR-049: a site may have several Secondary drawings). */
export function drawingLabel(
  kind: DrawingKind,
  ordinal: number,
): { key: MessageKey; params: Record<string, number> } {
  return kind === 'general'
    ? { key: 'siteDrawings.label.general', params: {} }
    : { key: 'siteDrawings.label.secondary', params: { n: ordinal } };
}

/** WGS84 for display only, 6 decimals (about 10 cm). */
export function gpsText(lat: number, lon: number): string {
  return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
}
