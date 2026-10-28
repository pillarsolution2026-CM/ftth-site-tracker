import {
  CAD_STALE_AFTER_MINUTES,
  type DesignRevisionCounts,
  type DesignRevisionStatus,
  type DiffCounts,
  type DrawingUnit,
  type MappingRule,
  type TextLinkCounts,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';

/** One design revision with the frozen inputs it was built from (ADR-017). */
export interface DesignRevision {
  id: string;
  projectId: string;
  cadFileId: string;
  cadFileName: string;
  /** Assigned on publish. */
  revNo: number | null;
  status: DesignRevisionStatus;
  /** The only job allowed to move this revision forward (ADR-013 guard). */
  currentJobId: string;
  baseRevisionId: string | null;
  rules: MappingRule[];
  mappingVersion: number;
  crsEpsg: number;
  drawingUnit: DrawingUnit;
  /** Exact decimal string. */
  metresPerUnit: string;
  insUnits: number | null;
  unitsConflict: boolean;
  counts: DesignRevisionCounts | null;
  textLinkCounts: TextLinkCounts | null;
  diffCounts: DiffCounts | null;
  tilesStorageKey: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  log: string | null;
  createdById: string | null;
  createdAt: Date;
  queuedAt: Date;
  buildStartedAt: Date | null;
  builtAt: Date | null;
  publishedAt: Date | null;
  publishedById: string | null;
}

/** Statuses whose features, text links and diff are meaningful to show (the worker has finished). */
export const BUILT_STATUSES: readonly DesignRevisionStatus[] = ['draft', 'published', 'discarded'];

export const hasBuiltContent = (revision: DesignRevision): boolean =>
  BUILT_STATUSES.includes(revision.status);

/** A queued or building revision that has not moved for longer than CAD_STALE_AFTER_MINUTES. */
export function isStaleInProgress(revision: DesignRevision, now: Date): boolean {
  if (revision.status !== 'queued' && revision.status !== 'building') return false;
  const since =
    revision.status === 'building'
      ? (revision.buildStartedAt ?? revision.queuedAt)
      : revision.queuedAt;
  return now.getTime() - since.getTime() > CAD_STALE_AFTER_MINUTES * 60_000;
}

/** Only draft and failed revisions, or stale queued/building ones, may be discarded. */
export function assertDiscardable(revision: DesignRevision, now: Date): void {
  const ok =
    revision.status === 'draft' || revision.status === 'failed' || isStaleInProgress(revision, now);
  if (!ok) {
    throw new AppError('CONFLICT', 'The revision cannot be discarded in its current state', {
      reason: 'NOT_DISCARDABLE',
      status: revision.status,
    });
  }
}

/** Reviews change a draft only; a published or discarded revision is locked (database triggers too). */
export function assertReviewable(revision: DesignRevision): void {
  if (revision.status !== 'draft') {
    throw new AppError('CONFLICT', 'The revision is not a draft and cannot be changed', {
      reason: 'REVISION_LOCKED',
      status: revision.status,
    });
  }
}

export function assertPublishable(revision: DesignRevision): void {
  if (revision.status !== 'draft') {
    throw new AppError('CONFLICT', 'Only a draft revision can be published', {
      reason: 'NOT_DRAFT',
      status: revision.status,
    });
  }
}
