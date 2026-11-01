import type {
  AsBuiltEdit,
  AsBuiltEditFlag,
  AsBuiltGeometry,
  CatalogItem,
  ExecutionUpdate,
  OfflineFeature,
  OpResult,
  PhotoRequirement,
  UpdateFlag,
  UpdateLineRole,
  WorkType,
} from '@ftth/shared';
import type { DomainEventInput } from '../../../common/event-log.port.js';
import type { ApprovedVersions } from '../../asbuilt/domain/review.js';

/** Where the caller may act: the whole project, or the features inside some zones. */
export type ExecutionScope = { kind: 'project' } | { kind: 'zones'; zoneIds: readonly string[] };

export interface StoredOperation {
  projectId: string;
  userId: string;
  deviceId: string;
  payloadSha256: string;
  result: OpResult;
}

export interface FeatureInRevision {
  featureType: ExecutionUpdate['featureType'];
  revisionPublishedAt: Date;
}

export interface LatestRevision {
  id: string;
  revNo: number;
  publishedAt: Date;
  hasTiles: boolean;
}

export interface ItemFacts {
  id: string;
  workType: WorkType | null;
}

export interface NewUpdate {
  id: string;
  projectId: string;
  clientOpId: string;
  featureId: string;
  featureType: ExecutionUpdate['featureType'];
  designRevisionId: string;
  workType: WorkType;
  userId: string;
  deviceId: string;
  capturedAt: Date;
  receivedAt: Date;
  label: string | null;
  note: string | null;
  gps: { lon: number; lat: number; accuracyM: number | null; at: Date } | null;
  flags: readonly UpdateFlag[];
  acknowledgedWarnings: readonly string[];
  lines: readonly { workOrderItemId: string; quantity: string; role: UpdateLineRole }[];
  photos: readonly {
    photoId: string;
    requirementKey: string;
    sha256: string;
    sizeBytes: number;
    takenAt: Date;
    gps: { lon: number; lat: number; accuracyM: number | null } | null;
  }[];
}

/** Repositories inside one transaction (ADR-024: one push operation = one transaction). */
export interface ExecutionTx {
  /** Serialises writes per project so `sync_seq` order equals commit order (pull cursor safety). */
  lockProject(projectId: string): Promise<void>;
  findOperation(clientOpId: string): Promise<StoredOperation | null>;
  insertOperation(input: {
    clientOpId: string;
    projectId: string;
    userId: string;
    deviceId: string;
    kind: string;
    payloadSha256: string;
    result: OpResult;
    receivedAt: Date;
  }): Promise<void>;
  featureExists(projectId: string, featureId: string): Promise<boolean>;
  /** The feature as drawn in `revisionId`, only if that revision is published. */
  featureInPublishedRevision(
    projectId: string,
    revisionId: string,
    featureId: string,
  ): Promise<FeatureInRevision | null>;
  featureInScope(
    projectId: string,
    revisionId: string,
    featureId: string,
    scope: ExecutionScope,
  ): Promise<boolean>;
  latestPublishedRevision(projectId: string): Promise<LatestRevision | null>;
  featureInRevision(projectId: string, revisionId: string, featureId: string): Promise<boolean>;
  findItems(projectId: string, itemIds: readonly string[]): Promise<ItemFacts[]>;
  /** True when, adding `lines`, some item's non-rejected recorded quantity exceeds its quantity. */
  wouldOverrun(
    projectId: string,
    lines: readonly { workOrderItemId: string; quantity: string }[],
  ): Promise<boolean>;
  /** Metres from the WGS 84 fix (converted to the revision CRS) to the feature geometry. */
  gpsDistanceM(
    projectId: string,
    revisionId: string,
    featureId: string,
    gps: { lon: number; lat: number },
  ): Promise<number>;
  anyPhotoExists(photoIds: readonly string[]): Promise<boolean>;
  insertUpdate(update: NewUpdate): Promise<void>;
  appendEvent(event: DomainEventInput): Promise<void>;

  // ---- As-Built edits (Phase 4, ADR-030) -------------------------------------------------
  /** The revision only if it is a published revision of the project. */
  publishedRevision(
    projectId: string,
    revisionId: string,
  ): Promise<{ publishedAt: Date; crsEpsg: number } | null>;
  /** True when the id is a design feature (any project) or was used by an earlier add. */
  featureIdTaken(featureId: string): Promise<boolean>;
  /** A design feature of the project, or an approved added feature; null when neither. */
  asBuiltTarget(
    projectId: string,
    featureId: string,
  ): Promise<{ featureType: AsBuiltEdit['featureType']; origin: 'design' | 'added' } | null>;
  /** PostGIS verdict on a proposed geometry in `srid`: `ST_IsValid` and `ST_Length` in metres. */
  geometryFacts(
    srid: number,
    geometry: AsBuiltGeometry,
  ): Promise<{ valid: boolean; lengthM: number }>;
  /** True when the proposed geometry intersects one of the scope's zones. */
  geometryInScope(
    projectId: string,
    srid: number,
    geometry: AsBuiltGeometry,
    scope: ExecutionScope,
  ): Promise<boolean>;
  /** True when the approved As-Built geometry of an added feature is inside the scope. */
  addedFeatureInScope(
    projectId: string,
    featureId: string,
    scope: ExecutionScope,
  ): Promise<boolean>;
  approvedVersions(projectId: string, featureId: string): Promise<ApprovedVersions>;
  insertAsBuiltEdit(edit: NewAsBuiltEdit): Promise<{ lengthM: string | null }>;
}

export interface NewAsBuiltEdit {
  id: string;
  projectId: string;
  clientOpId: string;
  featureId: string;
  kind: AsBuiltEdit['kind'];
  featureType: AsBuiltEdit['featureType'];
  designRevisionId: string;
  baseVersion: number | null;
  /** Project-CRS metres in `srid`. */
  geometry: AsBuiltGeometry | null;
  srid: number;
  label: string | null;
  note: string | null;
  userId: string;
  deviceId: string;
  capturedAt: Date;
  receivedAt: Date;
  gps: { lon: number; lat: number; accuracyM: number | null; at: Date } | null;
  flags: readonly AsBuiltEditFlag[];
}

export interface ExecutionUnitOfWork {
  run<T>(work: (tx: ExecutionTx) => Promise<T>): Promise<T>;
}

export interface ExecutionReadQueries {
  projectInfo(projectId: string): Promise<{ id: string; name: string; crsEpsg: number } | null>;
  latestPublishedRevision(projectId: string): Promise<LatestRevision | null>;
  featuresInScope(
    projectId: string,
    revisionId: string,
    scope: ExecutionScope,
  ): Promise<OfflineFeature[]>;
  catalog(projectId: string): Promise<CatalogItem[]>;
  changes(
    projectId: string,
    scope: ExecutionScope,
    cursor: string,
    limit: number,
  ): Promise<{ updates: ExecutionUpdate[]; seqs: string[] }>;
}

/**
 * Phase 2 data the update tool would use (ADR-023). Until `type_rules` and BOQ matching exist the
 * only implementation answers "unavailable"; nothing is guessed.
 */
export interface ExecutionCapabilities {
  suggestedQuantity(): 'available' | 'unavailable';
  photoRequirements(): {
    status: 'available' | 'unavailable';
    byWorkType: Record<string, PhotoRequirement[]>;
    fallback: PhotoRequirement[];
  };
  gpsWarningDistanceM(): number;
}

// ---- photo upload -------------------------------------------------------------------------

export interface PhotoUploadRow {
  photoId: string;
  projectId: string;
  uploaderId: string;
  sha256: string;
  sizeBytes: number;
  receivedBytes: number;
  storedAt: Date | null;
  updateId: string;
}

export interface PhotoUploadTx {
  /** Locks the row; null when absent or in another project. */
  findForUpdate(projectId: string, photoId: string): Promise<PhotoUploadRow | null>;
  appendChunk(
    photoId: string,
    offset: number,
    data: Buffer,
    receivedAfter: number,
    at: Date,
  ): Promise<void>;
  /** Bytes the user holds in unfinished uploads, in every project. */
  unfinishedBytesOf(userId: string): Promise<number>;
  readChunks(photoId: string): Promise<Buffer>;
  resetUpload(photoId: string): Promise<void>;
  markStored(photoId: string, storageKey: string, at: Date): Promise<void>;
  appendEvent(event: DomainEventInput): Promise<void>;
}

export interface PhotoUploadUnitOfWork {
  run<T>(work: (tx: PhotoUploadTx) => Promise<T>): Promise<T>;
  find(projectId: string, photoId: string): Promise<PhotoUploadRow | null>;
  /** Drops the chunks of unfinished uploads idle since `before`; returns how many photos. */
  discardIdleUploads(before: Date): Promise<number>;
}
