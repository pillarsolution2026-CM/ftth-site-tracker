import type { MessageKey } from '@ftth/i18n';
import type {
  AsBuiltEditDetail,
  AsBuiltEditFlag,
  AsBuiltEditKind,
  AsBuiltEditStatus,
  AsBuiltExportStatus,
  FeatureType,
} from '@ftth/shared';
import type { ClientErrorCode } from '@/shared/api/bff-client';

export const EDITS_PAGE_SIZE = 20;
export const EXPORT_POLL_MS = 3000;

export type StatusFilter = AsBuiltEditStatus | 'all';
export const STATUS_FILTERS: readonly StatusFilter[] = ['pending', 'approved', 'rejected', 'all'];
export const DEFAULT_STATUS_FILTER: StatusFilter = 'pending';

export function isStatusFilter(value: string): value is StatusFilter {
  return (STATUS_FILTERS as readonly string[]).includes(value);
}

export const FILTER_LABEL: Record<StatusFilter, MessageKey> = {
  pending: 'asbuiltReview.filter.pending',
  approved: 'asbuiltReview.filter.approved',
  rejected: 'asbuiltReview.filter.rejected',
  all: 'asbuiltReview.filter.all',
};

export interface EditListParams {
  status?: AsBuiltEditStatus;
  limit: number;
  offset: number;
}

/** `limit/offset` query of the list endpoint; `all` leaves the status out. */
export function listQuery(filter: StatusFilter, page: number): EditListParams {
  return {
    ...(filter === 'all' ? {} : { status: filter }),
    limit: EDITS_PAGE_SIZE,
    offset: (Math.max(page, 1) - 1) * EDITS_PAGE_SIZE,
  };
}

interface Presentation {
  icon: string;
  labelKey: MessageKey;
  className: string;
}

/** Status is icon + text; the border colour only reinforces it. */
export const EDIT_STATUS_PRESENTATION: Record<AsBuiltEditStatus, Presentation> = {
  pending: {
    icon: '…',
    labelKey: 'asbuiltReview.status.pending',
    className: 'border-(--status-inProgress)',
  },
  approved: {
    icon: '✓',
    labelKey: 'asbuiltReview.status.approved',
    className: 'border-(--status-approved)',
  },
  rejected: {
    icon: '✕',
    labelKey: 'asbuiltReview.status.rejected',
    className: 'border-(--status-rejected)',
  },
};

export const EXPORT_STATUS_PRESENTATION: Record<AsBuiltExportStatus, Presentation> = {
  queued: {
    icon: '…',
    labelKey: 'asbuiltReview.exports.status.queued',
    className: 'border-(--status-notStarted)',
  },
  processing: {
    icon: '⟳',
    labelKey: 'asbuiltReview.exports.status.processing',
    className: 'border-(--status-inProgress)',
  },
  done: {
    icon: '✓',
    labelKey: 'asbuiltReview.exports.status.done',
    className: 'border-(--status-approved)',
  },
  failed: {
    icon: '✕',
    labelKey: 'asbuiltReview.exports.status.failed',
    className: 'border-(--status-rejected)',
  },
};

export function isExportRunning(status: AsBuiltExportStatus): boolean {
  return status === 'queued' || status === 'processing';
}

export const FLAG_LABEL: Record<AsBuiltEditFlag, MessageKey> = {
  BASE_OUTDATED: 'asbuiltReview.flag.BASE_OUTDATED',
  REVISION_OUTDATED: 'asbuiltReview.flag.REVISION_OUTDATED',
  FEATURE_REMOVED: 'asbuiltReview.flag.FEATURE_REMOVED',
  CLOCK_AHEAD: 'asbuiltReview.flag.CLOCK_AHEAD',
};

export const FLAG_EXPLANATION: Record<AsBuiltEditFlag, MessageKey> = {
  BASE_OUTDATED: 'asbuiltReview.flagExplain.BASE_OUTDATED',
  REVISION_OUTDATED: 'asbuiltReview.flagExplain.REVISION_OUTDATED',
  FEATURE_REMOVED: 'asbuiltReview.flagExplain.FEATURE_REMOVED',
  CLOCK_AHEAD: 'asbuiltReview.flagExplain.CLOCK_AHEAD',
};

export const KIND_LABEL: Record<AsBuiltEditKind, MessageKey> = {
  move: 'asbuiltReview.kind.move',
  reshape: 'asbuiltReview.kind.reshape',
  add_route: 'asbuiltReview.kind.add_route',
  add_symbol: 'asbuiltReview.kind.add_symbol',
  label: 'asbuiltReview.kind.label',
};

export const FEATURE_TYPE_LABEL: Record<FeatureType, MessageKey> = {
  route: 'featureType.route',
  box: 'featureType.box',
  hhi: 'featureType.hhi',
  joint: 'featureType.joint',
  mh: 'featureType.mh',
};

export type ApproveBlock = 'noPermission' | 'notPending' | 'stale';

/**
 * Why the approve button cannot be used, or null when it can. The API stays the authority; this
 * only explains. `approvable` from the server already means pending and base still current.
 */
export function approveBlockedReason(
  detail: AsBuiltEditDetail,
  canReview: boolean,
): ApproveBlock | null {
  if (!canReview) return 'noPermission';
  if (detail.edit.status !== 'pending') return 'notPending';
  return detail.approvable ? null : 'stale';
}

export const APPROVE_BLOCK_KEY: Record<ApproveBlock, MessageKey> = {
  noPermission: 'asbuiltReview.notApprovable.noPermission',
  notPending: 'asbuiltReview.notApprovable.notPending',
  stale: 'asbuiltReview.notApprovable.stale',
};

/** Refusals of a review (`details.reason`) get their own message; the rest the generic one. */
export function reviewErrorKey(code: ClientErrorCode, reason: string | null): MessageKey {
  if (code === 'FORBIDDEN' && reason === 'SELF_REVIEW') return 'asbuiltReview.error.SELF_REVIEW';
  if (code === 'CONFLICT' && reason === 'NOT_PENDING') return 'asbuiltReview.error.NOT_PENDING';
  if (code === 'CONFLICT' && reason === 'STALE_BASE') return 'asbuiltReview.error.STALE_BASE';
  return `errors.${code}`;
}

export function exportErrorKey(code: ClientErrorCode, reason: string | null): MessageKey {
  if (code === 'CONFLICT' && reason === 'NO_PUBLISHED_REVISION') {
    return 'asbuiltReview.exports.error.NO_PUBLISHED_REVISION';
  }
  return `errors.${code}`;
}
