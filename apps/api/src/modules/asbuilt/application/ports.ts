import type {
  AsBuiltEdit,
  AsBuiltEditDetail,
  AsBuiltEditListQuery,
  AsBuiltEditListResponse,
  AsBuiltExport,
  AsBuiltFeatureState,
  AsBuiltLengthsResponse,
  AsBuiltStateResponse,
} from '@ftth/shared';
import type { Readable } from 'node:stream';
import type { DomainEventInput } from '../../../common/event-log.port.js';
import type { ApprovedVersions } from '../domain/review.js';

/** Where the caller may read or review: the whole project, or what touches some zones. */
export type AsBuiltScope = { kind: 'project' } | { kind: 'zones'; zoneIds: readonly string[] };

/** Read side (also used by the sync pull / bootstrap and by Phase 5 through `AsBuiltLengthsPort`). */
export interface AsBuiltReadQueries {
  listEdits(
    projectId: string,
    scope: AsBuiltScope,
    query: AsBuiltEditListQuery,
  ): Promise<AsBuiltEditListResponse>;
  /** Null when absent, in another project or outside the scope (IDOR defence). */
  detail(projectId: string, scope: AsBuiltScope, editId: string): Promise<AsBuiltEditDetail | null>;
  state(projectId: string, scope: AsBuiltScope): Promise<AsBuiltStateResponse | null>;
}

/** Edits changed after a pull cursor, for `GET sync/changes`. */
export interface AsBuiltEditFeed {
  editsAfter(
    projectId: string,
    scope: AsBuiltScope,
    cursor: string,
    limit: number,
  ): Promise<{ seq: string; edit: AsBuiltEdit }[]>;
}

/** Approved state in scope, for `GET sync/bootstrap`. */
export interface AsBuiltStateReader {
  stateInScope(projectId: string, scope: AsBuiltScope): Promise<AsBuiltFeatureState[]>;
}

/**
 * Approved route lengths (Phase 5 read model, ADR-030). The only way quantities may read As-Built
 * lengths: approved As-Built `ST_Length` if the route has an approved geometry, otherwise the
 * design length of the latest published revision. Nothing pending counts.
 */
export interface AsBuiltLengthsPort {
  routeLengths(projectId: string, scope?: AsBuiltScope): Promise<AsBuiltLengthsResponse>;
}

// ---- review ---------------------------------------------------------------------------------

export interface EditForReview {
  id: string;
  kind: AsBuiltEdit['kind'];
  featureId: string;
  featureType: AsBuiltEdit['featureType'];
  status: AsBuiltEdit['status'];
  baseVersion: number | null;
  userId: string;
  label: string | null;
  hasGeometry: boolean;
  lengthM: string | null;
}

export interface AsBuiltReviewTx {
  /** Serialises with sync pushes (same project lock). */
  lockProject(projectId: string): Promise<void>;
  /** Row-locked; null when absent, in another project or outside the scope. */
  findEditForReview(
    projectId: string,
    editId: string,
    scope: AsBuiltScope,
  ): Promise<EditForReview | null>;
  currentVersions(projectId: string, featureId: string): Promise<ApprovedVersions>;
  markApproved(input: {
    projectId: string;
    editId: string;
    reviewerId: string;
    approvedVersion: number;
    at: Date;
  }): Promise<void>;
  markRejected(input: {
    projectId: string;
    editId: string;
    reviewerId: string;
    reason: string;
    at: Date;
  }): Promise<void>;
  /** Writes the approved state of `edit` into `asbuilt_features` (insert or move forward). */
  applyApproval(input: {
    projectId: string;
    editId: string;
    approvedVersion: number;
  }): Promise<void>;
  findEdit(projectId: string, editId: string): Promise<AsBuiltEdit>;
  appendEvent(event: DomainEventInput): Promise<void>;
}

export interface AsBuiltReviewUnitOfWork {
  run<T>(work: (tx: AsBuiltReviewTx) => Promise<T>): Promise<T>;
}

// ---- export ---------------------------------------------------------------------------------

export interface ExportRecord extends AsBuiltExport {
  revNo: number;
  storageKey: string | null;
}

export interface AsBuiltExportTx {
  latestPublishedRevision(projectId: string): Promise<{ id: string; revNo: number } | null>;
  insert(input: {
    id: string;
    projectId: string;
    revisionId: string;
    jobId: string;
    requestedBy: string;
    at: Date;
  }): Promise<void>;
  /** queued → failed(ENQUEUE_FAILED) only if `jobId` is still the current job. */
  markEnqueueFailed(projectId: string, exportId: string, jobId: string, at: Date): Promise<boolean>;
  find(projectId: string, exportId: string): Promise<ExportRecord | null>;
  appendEvent(event: DomainEventInput): Promise<void>;
}

export interface AsBuiltExportUnitOfWork {
  run<T>(work: (tx: AsBuiltExportTx) => Promise<T>): Promise<T>;
}

export interface AsBuiltExportQueries {
  list(projectId: string, limit: number): Promise<AsBuiltExport[]>;
  find(projectId: string, exportId: string): Promise<ExportRecord | null>;
}

export interface AsBuiltJobQueue {
  enqueueExport(job: {
    id: string;
    exportId: string;
    projectId: string;
    attempt: number;
    enqueuedAt: string;
  }): Promise<void>;
}

export interface DownloadedExport {
  stream: Readable;
  sizeBytes: number;
  fileName: string;
}
