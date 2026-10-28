import type { MessageKey } from '@ftth/i18n';
import type { DesignRevisionStatus } from '@ftth/shared';

export const REVISION_POLL_MS = 3000;

/** The worker is (or will be) building: keep polling. */
export function isBuilding(status: DesignRevisionStatus): boolean {
  return status === 'queued' || status === 'building';
}

/** Counts, text links and the diff exist once the build has finished. */
export function isBuilt(status: DesignRevisionStatus): boolean {
  return status === 'draft' || status === 'published';
}

/** Status is always icon + text; the border colour only reinforces it. */
export const REVISION_STATUS_PRESENTATION: Record<
  DesignRevisionStatus,
  { icon: string; labelKey: MessageKey; className: string }
> = {
  queued: {
    icon: '…',
    labelKey: 'design.status.queued',
    className: 'border-(--status-notStarted)',
  },
  building: {
    icon: '⟳',
    labelKey: 'design.status.building',
    className: 'border-(--status-inProgress)',
  },
  draft: { icon: '✎', labelKey: 'design.status.draft', className: 'border-(--status-executed)' },
  failed: { icon: '✕', labelKey: 'design.status.failed', className: 'border-(--status-rejected)' },
  published: {
    icon: '✓',
    labelKey: 'design.status.published',
    className: 'border-(--status-approved)',
  },
  discarded: {
    icon: '⊘',
    labelKey: 'design.status.discarded',
    className: 'border-(--status-notStarted)',
  },
};
