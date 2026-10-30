import type {
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
  appendChunk(photoId: string, offset: number, data: Buffer, receivedAfter: number): Promise<void>;
  readChunks(photoId: string): Promise<Buffer>;
  resetUpload(photoId: string): Promise<void>;
  markStored(photoId: string, storageKey: string, at: Date): Promise<void>;
  appendEvent(event: DomainEventInput): Promise<void>;
}

export interface PhotoUploadUnitOfWork {
  run<T>(work: (tx: PhotoUploadTx) => Promise<T>): Promise<T>;
  find(projectId: string, photoId: string): Promise<PhotoUploadRow | null>;
}
