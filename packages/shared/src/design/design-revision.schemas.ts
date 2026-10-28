import { z } from 'zod';
import { DrawingUnitSchema } from '../cad/drawing-units.js';
import { MappingRuleSchema } from '../cad/cad-mapping.schemas.js';
import { DecimalStringSchema } from '../common/decimal.js';
import { BooleanQuerySchema, PageQuerySchema, pageSchema } from '../common/pagination.js';
import { FeatureTypeSchema, FEATURE_TYPES } from './feature-types.js';
import { TextLinkKindSchema, TextLinkStatusSchema } from './text-link.js';

/**
 * Design revisions (ADR-017, ADR-020). A revision is built by the worker from a processed CAD file
 * and a frozen copy of its mapping, reviewed as a `draft`, then `published` — after which it and
 * everything under it is immutable (database triggers). Feature ids are stable across revisions:
 * the worker matches each new feature to the last published revision (ADR-020).
 *
 * queued → building → draft → published
 *                   ↘ failed     ↘ discarded
 * At most one revision per project is queued/building/draft at a time.
 */
export const DESIGN_REVISION_STATUSES = [
  'queued',
  'building',
  'draft',
  'failed',
  'published',
  'discarded',
] as const;
export const DesignRevisionStatusSchema = z.enum(DESIGN_REVISION_STATUSES);
export type DesignRevisionStatus = z.infer<typeof DesignRevisionStatusSchema>;

export const REVISION_FAILURE_CODES = [
  'MAPPING_INVALID',
  'CAD_FILE_NOT_PROCESSED',
  'TILES_FAILED',
  'MAX_ATTEMPTS_EXCEEDED',
  'ENQUEUE_FAILED',
  'INTERNAL',
] as const;
export const RevisionFailureCodeSchema = z.enum(REVISION_FAILURE_CODES);
export type RevisionFailureCode = z.infer<typeof RevisionFailureCodeSchema>;

export const DIFF_CHANGES = [
  /** New feature (new stable id). */
  'added',
  /** Feature of the base revision with no match in this one. */
  'removed',
  'unchanged',
  /** Point moved, or a route's shape/length changed (beyond 1 mm). */
  'moved',
  'reshaped',
  /** Same geometry, different code. */
  'attributes_changed',
  /** Several base features fit equally well; matched to the nearest, PM should check. */
  'conflict',
] as const;
export const DiffChangeSchema = z.enum(DIFF_CHANGES);
export type DiffChange = z.infer<typeof DiffChangeSchema>;

const CountsByFeatureType = z.object(
  Object.fromEntries(FEATURE_TYPES.map((t) => [t, z.number().int().min(0)])) as Record<
    (typeof FEATURE_TYPES)[number],
    z.ZodNumber
  >,
);

export const DesignRevisionCountsSchema = z.object({
  features: CountsByFeatureType,
  /** Σ route lengths in metres (through the revision's drawing unit), 3 decimals. */
  routeLengthM: DecimalStringSchema,
});
export type DesignRevisionCounts = z.infer<typeof DesignRevisionCountsSchema>;

export const TextLinkCountsSchema = z.object(
  Object.fromEntries(
    TextLinkStatusSchema.options.map((s) => [s, z.number().int().min(0)]),
  ) as Record<z.infer<typeof TextLinkStatusSchema>, z.ZodNumber>,
);
export type TextLinkCounts = z.infer<typeof TextLinkCountsSchema>;

export const DiffCountsSchema = z.object(
  Object.fromEntries(DIFF_CHANGES.map((c) => [c, z.number().int().min(0)])) as Record<
    DiffChange,
    z.ZodNumber
  >,
);
export type DiffCounts = z.infer<typeof DiffCountsSchema>;

export const DesignRevisionSummarySchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  cadFileId: z.uuid(),
  cadFileName: z.string(),
  /** Assigned on publish (1, 2, …); null before. */
  revNo: z.number().int().min(1).nullable(),
  status: DesignRevisionStatusSchema,
  crsEpsg: z.number().int(),
  drawingUnit: DrawingUnitSchema,
  metresPerUnit: DecimalStringSchema,
  insUnits: z.number().int().nullable(),
  /** `$INSUNITS` disagreed with the detected CRS when the revision was created (ADR-018). */
  unitsConflict: z.boolean(),
  /** Last published revision at build time; null for the first revision. */
  baseRevisionId: z.uuid().nullable(),
  /** null until built. */
  counts: DesignRevisionCountsSchema.nullable(),
  textLinkCounts: TextLinkCountsSchema.nullable(),
  /** null until built; all `added` when there is no base revision. */
  diffCounts: DiffCountsSchema.nullable(),
  hasTiles: z.boolean(),
  errorCode: RevisionFailureCodeSchema.nullable(),
  createdById: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  builtAt: z.iso.datetime().nullable(),
  publishedAt: z.iso.datetime().nullable(),
  publishedById: z.uuid().nullable(),
});
export type DesignRevisionSummary = z.infer<typeof DesignRevisionSummarySchema>;

export const DesignRevisionDetailSchema = DesignRevisionSummarySchema.extend({
  /** Frozen copy of the mapping rules used for the build. */
  rules: z.array(MappingRuleSchema),
  errorMessage: z.string().nullable(),
  log: z.string().nullable(),
});
export type DesignRevisionDetail = z.infer<typeof DesignRevisionDetailSchema>;

export const DesignRevisionListResponseSchema = z.object({
  items: z.array(DesignRevisionSummarySchema),
});
export type DesignRevisionListResponse = z.infer<typeof DesignRevisionListResponseSchema>;

/** POST /projects/:projectId/design-revisions — builds from the file's saved mapping. */
export const CreateDesignRevisionRequestSchema = z.object({
  cadFileId: z.uuid(),
  /** Version of the mapping the PM looked at; a newer saved mapping → 409. */
  mappingVersion: z.number().int().min(1),
});
export type CreateDesignRevisionRequest = z.infer<typeof CreateDesignRevisionRequestSchema>;

/** POST …/design-revisions/:revisionId/publish */
export const PublishDesignRevisionRequestSchema = z.object({
  /**
   * Required when text links still need review or the diff has conflicts. After publishing they
   * stay as they are (the revision is locked).
   */
  acknowledgeOpenItems: z.boolean().default(false),
});
export type PublishDesignRevisionRequest = z.infer<typeof PublishDesignRevisionRequestSchema>;

/** 409 details when publishing with open items and no acknowledgement. */
export const PublishBlockedDetailsSchema = z.object({
  reason: z.literal('OPEN_ITEMS'),
  textLinksToReview: z.number().int().min(0),
  diffConflicts: z.number().int().min(0),
});
export type PublishBlockedDetails = z.infer<typeof PublishBlockedDetailsSchema>;

// ---------- features ----------

export const SOURCE_KINDS = ['curve', 'insert', 'text'] as const;
export const SourceKindSchema = z.enum(SOURCE_KINDS);

export const DesignFeatureSchema = z.object({
  /** Stable feature id (same across revisions). */
  id: z.uuid(),
  revisionId: z.uuid(),
  featureType: FeatureTypeSchema,
  /** e.g. box id "1-1" from its best linked `box_id` text; null when none. */
  code: z.string().nullable(),
  layer: z.string(),
  blockName: z.string().nullable(),
  sourceKind: SourceKindSchema,
  sourceHandle: z.string(),
  /** Routes only: length in metres (3 decimals) in the revision CRS. */
  lengthM: DecimalStringSchema.nullable(),
  /** Point features: position; routes: first vertex. Project CRS (metres). */
  anchor: z.object({ x: z.number(), y: z.number() }),
  /** Insert attributes (decoded) and linked texts by kind. */
  attrs: z.record(z.string(), z.unknown()),
});
export type DesignFeature = z.infer<typeof DesignFeatureSchema>;

export const DesignFeatureListQuerySchema = PageQuerySchema.extend({
  featureType: FeatureTypeSchema.optional(),
  q: z.string().min(1).max(100).optional(),
});
export type DesignFeatureListQuery = z.infer<typeof DesignFeatureListQuerySchema>;
export const DesignFeaturePageSchema = pageSchema(DesignFeatureSchema);
export type DesignFeaturePage = z.infer<typeof DesignFeaturePageSchema>;

// ---------- text links (review list) ----------

export const TextLinkSchema = z.object({
  id: z.uuid(),
  revisionId: z.uuid(),
  textHandle: z.string(),
  layer: z.string(),
  /** Decoded text; null when unreadable. */
  text: z.string().nullable(),
  rawText: z.string(),
  readable: z.boolean(),
  kind: TextLinkKindSchema,
  status: TextLinkStatusSchema,
  featureId: z.uuid().nullable(),
  featureType: FeatureTypeSchema.nullable(),
  featureCode: z.string().nullable(),
  distanceM: DecimalStringSchema.nullable(),
  /** 0..1, 3 decimals. */
  confidence: DecimalStringSchema,
  position: z.object({ x: z.number(), y: z.number() }),
  reviewedById: z.uuid().nullable(),
  reviewedAt: z.iso.datetime().nullable(),
});
export type TextLink = z.infer<typeof TextLinkSchema>;

/** Default order: confidence ascending (least sure first), then handle. */
export const TextLinkListQuerySchema = PageQuerySchema.extend({
  status: TextLinkStatusSchema.optional(),
  kind: TextLinkKindSchema.optional(),
  readable: BooleanQuerySchema.optional(),
});
export type TextLinkListQuery = z.infer<typeof TextLinkListQuerySchema>;
export const TextLinkPageSchema = pageSchema(TextLinkSchema);
export type TextLinkPage = z.infer<typeof TextLinkPageSchema>;

/**
 * PATCH …/text-links/:linkId (draft revisions only).
 * confirm: keep (or set, with `featureId`) the feature; the feature type must be allowed for the
 * kind (TEXT_LINK_TARGETS). reject: the text is not linked. Unreadable texts can be linked or
 * rejected but their text is never guessed.
 */
export const ReviewTextLinkRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('confirm'), featureId: z.uuid().optional() }),
  z.object({ action: z.literal('reject') }),
]);
export type ReviewTextLinkRequest = z.infer<typeof ReviewTextLinkRequestSchema>;

// ---------- diff report ----------

export const DiffItemSchema = z.object({
  id: z.uuid(),
  /** Feature id in this revision, or the base revision's feature for `removed`. */
  featureId: z.uuid(),
  featureType: FeatureTypeSchema,
  change: DiffChangeSchema,
  code: z.string().nullable(),
  previousCode: z.string().nullable(),
  /** Points: distance moved; routes: Hausdorff distance to the matched base route. Metres. */
  distanceM: DecimalStringSchema.nullable(),
  /** Routes: length here − length in base. Metres, may be negative. */
  lengthDeltaM: DecimalStringSchema.nullable(),
  /** `conflict`: other base features that fit as well. */
  candidateFeatureIds: z.array(z.uuid()),
});
export type DiffItem = z.infer<typeof DiffItemSchema>;

export const DiffListQuerySchema = PageQuerySchema.extend({
  change: DiffChangeSchema.optional(),
  /** Default true: hide `unchanged`. */
  changedOnly: BooleanQuerySchema.optional(),
});
export type DiffListQuery = z.infer<typeof DiffListQuerySchema>;
export const DiffPageSchema = pageSchema(DiffItemSchema);
export type DiffPage = z.infer<typeof DiffPageSchema>;

// ---------- tiles (ADR-021) ----------

/**
 * POST …/design-revisions/:revisionId/tile-url → a short-lived signed URL template for the
 * Martin function source `design_features`. Placeholders `{z}/{x}/{y}` are left for MapLibre.
 */
export const TileUrlResponseSchema = z.object({
  urlTemplate: z.string(),
  expiresAt: z.iso.datetime(),
});
export type TileUrlResponse = z.infer<typeof TileUrlResponseSchema>;

export const TILE_URL_TTL_SECONDS = 3600;
/** Martin function source name (schema `tiles`, function `design_features`). */
export const TILE_SOURCE_DESIGN_FEATURES = 'design_features';

/**
 * Canonical string signed with HMAC-SHA256 (TILE_URL_SECRET), base64url without padding.
 * Query: `?p=<projectId>&r=<revisionId>&exp=<unix seconds>&sig=<signature>`.
 */
export function tileSignaturePayload(
  source: string,
  projectId: string,
  revisionId: string,
  exp: number,
): string {
  return `${source}|${projectId}|${revisionId}|${exp}`;
}
