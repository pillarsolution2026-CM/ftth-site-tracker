import type {
  DesignFeatureListQuery,
  DesignFeaturePage,
  DiffListQuery,
  DiffPage,
  DrawingKind,
  DrawingUnit,
  FeatureType,
  FrozenDrawingCorrection,
  FrozenBoxTypes,
  FrozenInstallation,
  InstallationRoute,
  MappingRule,
  Placement,
  PlacementDrawing,
  TextLink,
  TextLinkCounts,
  TextLinkKind,
  TextLinkListQuery,
  TextLinkPage,
  TextLinkStatus,
} from '@ftth/shared';
import type { CadMappingRecord } from './cad-mapping.js';
import type { DesignRevision } from './design-revision.js';

/** Every method filters by `projectId` (IDOR defence): another project's id is "not found". */
export interface CadMappingRepository {
  find(
    projectId: string,
    cadFileId: string,
    options?: { lock?: boolean },
  ): Promise<CadMappingRecord | null>;
  /** Version 1. */
  insert(mapping: Omit<CadMappingRecord, 'version'>): Promise<CadMappingRecord>;
  /** Version + 1, only when the stored version is `expectedVersion`; null otherwise. */
  update(
    mapping: Omit<CadMappingRecord, 'version'>,
    expectedVersion: number,
  ): Promise<CadMappingRecord | null>;
}

/** A sub cabinet feature of a revision (ADR-042 part G). */
export interface SubCabinetPosition {
  code: string | null;
  sourceHandle: string;
  /** Position in the revision CRS (metres). */
  x: number;
  y: number;
  attrs: Record<string, unknown>;
}

export interface NewDesignRevision {
  id: string;
  projectId: string;
  cadFileId: string;
  /** Kind of the source file (ADR-040); the database checks it matches. */
  drawingKind: DrawingKind;
  currentJobId: string;
  baseRevisionId: string | null;
  rules: MappingRule[];
  mappingVersion: number;
  crsEpsg: number;
  drawingUnit: DrawingUnit;
  metresPerUnit: string;
  placement: Placement | null;
  /** The file's corrections in force, in creation order (ADR-038). */
  corrections: FrozenDrawingCorrection[];
  /** The General's installation answer and marks in force (ADR-042); null for a Secondary. */
  installation: FrozenInstallation | null;
  /** The Secondary's box-type choices in force with a snapshot of their lines (ADR-043). */
  boxTypes: FrozenBoxTypes | null;
  insUnits: number | null;
  unitsConflict: boolean;
  createdById: string;
  queuedAt: Date;
}

export interface DesignRevisionRepository {
  /** created_at DESC. */
  list(projectId: string): Promise<DesignRevision[]>;
  find(
    projectId: string,
    revisionId: string,
    options?: { lock?: boolean },
  ): Promise<DesignRevision | null>;
  /** Id of the latest `published` revision of the kind (highest rev_no), if any. */
  findLatestPublishedId(projectId: string, kind: DrawingKind): Promise<string | null>;
  /** True while the project has a queued, building or draft revision of the kind (at most one). */
  hasOpen(projectId: string, kind: DrawingKind): Promise<boolean>;
  /** The open (queued, building or draft) revision of the kind, if any. */
  findOpen(projectId: string, kind: DrawingKind): Promise<DesignRevision | null>;
  /**
   * `code` of each `sub` cabinet feature of the revision (feature_type 'cabinet', attrs.role
   * 'sub'), null when unnamed; ordered by source handle. ADR-041.
   */
  subCabinetCodes(projectId: string, revisionId: string): Promise<(string | null)[]>;
  /** The route features of the revision as the installation check needs them (ADR-042). */
  installationRoutes(projectId: string, revisionId: string): Promise<InstallationRoute[]>;
  /** `handles` of the revision's frozen `merge_routes` corrections (ADR-038). */
  frozenMergeHandles(projectId: string, revisionId: string): Promise<string[][]>;
  /** The newest draft or published revision built from the file; null when there is none. */
  findLatestBuiltOfFile(projectId: string, cadFileId: string): Promise<DesignRevision | null>;
  /**
   * The `sub` cabinet features of the revision with their position in the revision CRS (metres)
   * and attrs, ordered by source handle. ADR-042 part G.
   */
  subCabinetPositions(
    projectId: string,
    revisionId: string,
    limit: number,
  ): Promise<SubCabinetPosition[]>;
  /** True while a revision built from this file is queued or building. */
  hasInProgressForFile(projectId: string, cadFileId: string): Promise<boolean>;
  /**
   * Inserts a `queued` revision. A concurrent second open revision is reported as
   * AppError CONFLICT (`reason: REVISION_IN_PROGRESS`).
   */
  insert(revision: NewDesignRevision): Promise<void>;
  /** queued → failed (ENQUEUE_FAILED) only if `jobId` is still current; false when it moved on. */
  markEnqueueFailed(
    projectId: string,
    revisionId: string,
    jobId: string,
    message: string,
  ): Promise<boolean>;
  /**
   * draft → published for every given revision (the pair, ADR-040) with the SAME rev_no = highest
   * rev_no of the project over both kinds + 1; returns that number.
   */
  publish(projectId: string, revisionIds: string[], actorId: string, at: Date): Promise<number>;
  /** → discarded; also replaces the job id so a still-running worker is superseded. */
  discard(projectId: string, revisionId: string, supersedingJobId: string): Promise<void>;
}

export interface TextLinkRecord {
  id: string;
  revisionId: string;
  kind: TextLinkKind;
  status: TextLinkStatus;
  featureId: string | null;
}

export interface OpenItems {
  textLinksToReview: number;
  diffConflicts: number;
}

export interface TextLinkRepository {
  find(
    projectId: string,
    revisionId: string,
    linkId: string,
    options?: { lock?: boolean },
  ): Promise<TextLinkRecord | null>;
  /** A feature of this revision (not of another revision or project), or null. */
  findFeature(
    projectId: string,
    revisionId: string,
    featureId: string,
  ): Promise<{ id: string; featureType: FeatureType } | null>;
  /**
   * status = confirmed, feature = `featureId`, distance recomputed from the geometries
   * (ST_Distance), confidence unchanged, reviewer recorded.
   */
  confirm(
    projectId: string,
    revisionId: string,
    linkId: string,
    featureId: string,
    actorId: string,
    at: Date,
  ): Promise<void>;
  /** status = rejected; the proposed feature and distance stay for the record. */
  reject(
    projectId: string,
    revisionId: string,
    linkId: string,
    actorId: string,
    at: Date,
  ): Promise<void>;
  /**
   * Sets each given box's `code` to the text of its best auto/confirmed `box_id` link
   * (highest confidence, then nearest), or NULL when it has none.
   */
  recomputeBoxCodes(projectId: string, revisionId: string, featureIds: string[]): Promise<void>;
  /** Recounts links per status and stores the result on the revision. */
  recomputeCounts(projectId: string, revisionId: string): Promise<TextLinkCounts>;
  countOpenItems(projectId: string, revisionId: string): Promise<OpenItems>;
}

/** Drawing problems written by the worker (ADR-033); Ignore is withdrawn (ADR-038). */
export interface DrawingProblemRepository {
  /** `design_revisions.warnings` as stored (problems and older count-only warnings). */
  warnings(projectId: string, revisionId: string): Promise<unknown>;
}

/** Read-side queries over what the worker wrote (lists are paged and ordered). */
export interface DesignReadQueries {
  features(
    projectId: string,
    revisionId: string,
    query: DesignFeatureListQuery,
  ): Promise<DesignFeaturePage>;
  textLinks(projectId: string, revisionId: string, query: TextLinkListQuery): Promise<TextLinkPage>;
  textLink(projectId: string, revisionId: string, linkId: string): Promise<TextLink | null>;
  diff(projectId: string, revisionId: string, query: DiffListQuery): Promise<DiffPage>;
}

export interface MappingBlockGroup {
  name: string;
  count: number;
  layers: string[];
}

export interface MappingTextGroup {
  layer: string;
  text: string;
  count: number;
}

/** Grouping queries behind the mapping screen. */
export interface CadMappingViewQueries {
  /** Inserts grouped by block name, ordered by name. */
  blocks(projectId: string, cadFileId: string): Promise<MappingBlockGroup[]>;
  /** Readable texts grouped by (layer, trimmed text): count DESC, layer, text; at most `limit`. */
  texts(projectId: string, cadFileId: string, limit: number): Promise<MappingTextGroup[]>;
  /**
   * Point items and route lines of the uploaded file in drawing units (ADR-037): the extracted
   * rows classified by the file's saved mapping rules as the build does, with no revision needed.
   * Empty (`mappingVersion` null) without a saved mapping, and empty while the file is not
   * processed. At most `maxLines` route lines, simplified to about `toleranceM` metres. An item's
   * `names` are the readable texts of at most `nameMaxChars` characters whose nearest item it is,
   * within `nameRadiusM` metres.
   */
  placementDrawing(
    projectId: string,
    cadFileId: string,
    limits: PlacementDrawingLimits,
  ): Promise<PlacementDrawing>;
}

export interface PlacementDrawingLimits {
  maxLines: number;
  toleranceM: number;
  nameRadiusM: number;
  nameMaxChars: number;
}
