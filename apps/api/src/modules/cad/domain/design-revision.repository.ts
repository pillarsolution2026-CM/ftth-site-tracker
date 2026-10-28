import type {
  DesignFeatureListQuery,
  DesignFeaturePage,
  DiffListQuery,
  DiffPage,
  DrawingUnit,
  FeatureType,
  MappingRule,
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

export interface NewDesignRevision {
  id: string;
  projectId: string;
  cadFileId: string;
  currentJobId: string;
  baseRevisionId: string | null;
  rules: MappingRule[];
  mappingVersion: number;
  crsEpsg: number;
  drawingUnit: DrawingUnit;
  metresPerUnit: string;
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
  /** Id of the project's latest `published` revision (highest rev_no), if any. */
  findLatestPublishedId(projectId: string): Promise<string | null>;
  /** True while the project has a queued, building or draft revision (at most one may exist). */
  hasOpen(projectId: string): Promise<boolean>;
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
  /** draft → published with rev_no = highest rev_no of the project + 1; returns that number. */
  publish(projectId: string, revisionId: string, actorId: string, at: Date): Promise<number>;
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
}
