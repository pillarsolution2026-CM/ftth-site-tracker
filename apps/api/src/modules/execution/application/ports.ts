import type {
  AsBuiltEdit,
  AsBuiltEditFlag,
  AsBuiltGeometry,
  CatalogItem,
  ExecutionUpdate,
  ElementGroups,
  ElementKey,
  GpsProposalFeatureType,
  ItemGroup,
  LineDimensions,
  LinePerformer,
  OfflineFeature,
  OpResult,
  PhotoRequirement,
  UpdateFlag,
  UpdateLineRole,
  WorkType,
} from '@ftth/shared';
import type { DomainEventInput } from '../../../common/event-log.port.js';
import type { ApprovedVersions } from '../../asbuilt/domain/review.js';

/** Where the caller may act: the whole project, or the features of some sites (ADR-054). */
export type ExecutionScope = { kind: 'project' } | { kind: 'sites'; siteIds: readonly string[] };

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

/** A published drawing the device may pick (ADR-049 part B), with its latest revision. */
export interface PublishedDrawing {
  drawingId: string;
  siteId: string | null;
  siteName: string | null;
  kind: 'general' | 'secondary';
  ordinal: number;
  revision: LatestRevision;
}

export interface LatestRevision {
  id: string;
  /** The drawing of the revision (ADR-049 part B). */
  drawingId?: string;
  revNo: number;
  publishedAt: Date;
  hasTiles: boolean;
}

/** A contractor line as locked for a push (ADR-052). */
export interface ContractorLineFacts {
  id: string;
  workOrderItemId: string;
  quantity: string;
  /** Pending + approved work already recorded on it (rejected work does not count). */
  recordedQuantity: string;
}

export interface ItemFacts {
  id: string;
  workType: WorkType | null;
  unit: string;
  /** Effective ADR-048 group of the contract line behind it (rule or admin choice); null = none. */
  group: ItemGroup | null;
}

/** A published drawing of the project as a «التخطيط» update sees it (ADR-056). */
export interface PlanningDrawing {
  drawingId: string;
  /** Null for a drawing not linked to a site yet (never in a site scope). */
  siteId: string | null;
}

export interface NewUpdate {
  id: string;
  projectId: string;
  clientOpId: string;
  /** Null for a «التخطيط» update (ADR-056): then `drawingId` is set. */
  featureId: string | null;
  featureType: ExecutionUpdate['featureType'];
  drawingId: string | null;
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
  lines: readonly {
    workOrderItemId: string;
    quantity: string;
    role: UpdateLineRole;
    performer: LinePerformer | null;
    dimensions: LineDimensions | null;
  }[];
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
  /**
   * The latest published revision of the SAME DRAWING as `ofRevisionId` (ADR-049 part B: feature
   * identity and `REVISION_OUTDATED` stay within one drawing).
   */
  latestPublishedRevision(projectId: string, ofRevisionId?: string): Promise<LatestRevision | null>;
  featureInRevision(projectId: string, revisionId: string, featureId: string): Promise<boolean>;
  findItems(
    projectId: string,
    itemIds: readonly string[],
    scope: ExecutionScope,
  ): Promise<ItemFacts[]>;
  /**
   * The contractor lines of the project among `ids`, row-locked (`FOR UPDATE`) until the end of
   * the transaction so the cap check and the insert cannot race an admin quantity edit.
   * Unknown ids and ids of another project are simply absent.
   */
  lockContractorLines(projectId: string, ids: readonly string[]): Promise<ContractorLineFacts[]>;
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
  /** ADR-056: the drawing when it is a drawing of the project with a published revision. */
  planningDrawing(projectId: string, drawingId: string): Promise<PlanningDrawing | null>;
  /** ADR-056: the revision only if it is a published revision of `drawingId` (either kind). */
  publishedRevisionOfDrawing(
    projectId: string,
    drawingId: string,
    revisionId: string,
  ): Promise<{ publishedAt: Date; crsEpsg: number } | null>;
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
  /** True when the drawing of the revision belongs to one of the scope's sites (ADR-054). */
  revisionInScope(projectId: string, revisionId: string, scope: ExecutionScope): Promise<boolean>;
  /**
   * True when an approved added feature was added on a drawing of one of the scope's sites
   * (through the revision its add edit was recorded on); false when nothing links it (fail closed).
   */
  addedFeatureInScope(
    projectId: string,
    featureId: string,
    scope: ExecutionScope,
  ): Promise<boolean>;
  /**
   * True when the geometry is not covered by the extent of the design features of the revision,
   * expanded by `toleranceM` (also true when the revision has no features).
   */
  geometryOutsideDrawing(
    projectId: string,
    revisionId: string,
    srid: number,
    geometry: AsBuiltGeometry,
    toleranceM: number,
  ): Promise<boolean>;
  approvedVersions(projectId: string, featureId: string): Promise<ApprovedVersions>;
  insertAsBuiltEdit(edit: NewAsBuiltEdit): Promise<{ lengthM: string | null }>;

  // ---- GPS point proposals (ADR-037) -----------------------------------------------------
  /** The feature as drawn in `revisionId` (published only) with where it came from in the file. */
  proposalTarget(
    projectId: string,
    revisionId: string,
    featureId: string,
  ): Promise<ProposalTarget | null>;
  insertGpsProposal(proposal: NewGpsProposal): Promise<void>;
}

export interface ProposalTarget {
  featureType: string;
  code: string | null;
  /** Drawing handle of the item in the file (`design_features.source_handle`). */
  handle: string;
  cadFileId: string;
}

export interface NewGpsProposal {
  id: string;
  projectId: string;
  clientOpId: string;
  designRevisionId: string;
  featureId: string;
  cadFileId: string;
  handle: string;
  featureType: GpsProposalFeatureType;
  code: string | null;
  fix: { lat: number; lon: number; accuracyM: number; at: Date };
  receivedAt: Date;
  proposedBy: string;
  deviceId: string;
  note: string | null;
  photo: {
    photoId: string;
    requirementKey: string;
    sha256: string;
    sizeBytes: number;
    takenAt: Date;
    gps: { lon: number; lat: number; accuracyM: number | null } | null;
  } | null;
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
  /** The latest published revision of `drawingId`, else of the General published last. */
  latestPublishedRevision(projectId: string, drawingId?: string): Promise<LatestRevision | null>;
  /**
   * Every published drawing (General and Secondary, linked or not) with its latest revision; for a
   * site scope only the drawings of those sites (ADR-054).
   */
  publishedDrawings(projectId: string, scope: ExecutionScope): Promise<PublishedDrawing[]>;
  featuresInScope(
    projectId: string,
    revisionId: string,
    scope: ExecutionScope,
  ): Promise<OfflineFeature[]>;
  /** Work-order lines; for a site scope only the lines of work orders that have one of his sites. */
  catalog(projectId: string, scope: ExecutionScope): Promise<CatalogItem[]>;
  /** ADR-056: the system map element → main groups (every element, map order). */
  elementGroups(): Promise<ElementGroups[]>;
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
  /** A photo belongs to an update or to a GPS point proposal (exactly one is set). */
  updateId: string | null;
  proposalId: string | null;
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

// ---- element -> main groups map (ADR-056) ------------------------------------------------------

export interface ElementGroupRow {
  element: ElementKey;
  mains: string[];
  version: number;
}

/** A main group used by contract lines, with how many lines carry it (all contracts). */
export interface UsedMainGroup {
  main: string;
  lineCount: number;
}

export interface ElementGroupAdminTx {
  /** The element's row, locked until the end of the transaction; null when absent. */
  lockElement(element: ElementKey): Promise<ElementGroupRow | null>;
  /** Replaces the list and takes the version to `version`. */
  replace(input: {
    element: ElementKey;
    mains: readonly string[];
    version: number;
    actorId: string;
    at: Date;
  }): Promise<void>;
  appendEvent(event: DomainEventInput): Promise<void>;
}

export interface ElementGroupAdmin {
  /** Every element row, in ELEMENT_KEYS order. */
  list(): Promise<ElementGroupRow[]>;
  /**
   * Main groups of the effective ADR-048 group (rule or admin choice) of every priced line of every
   * contract, draft or approved.
   */
  usedMainGroups(): Promise<UsedMainGroup[]>;
  run<T>(work: (tx: ElementGroupAdminTx) => Promise<T>): Promise<T>;
}
