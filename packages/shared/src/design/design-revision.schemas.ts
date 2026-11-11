import { z } from 'zod';
import { DrawingUnitSchema } from '../cad/drawing-units.js';
import { DrawingKindSchema } from '../cad/drawing-kind.schemas.js';
import { MappingRuleSchema } from '../cad/cad-mapping.schemas.js';
import { cabinetNameKey } from '../cad/text-roles.js';
import { PlacementSchema } from '../cad/placement.schemas.js';
import { DecimalStringSchema } from '../common/decimal.js';
import { BooleanQuerySchema, PageQuerySchema, pageSchema } from '../common/pagination.js';
import {
  CabinetRoleSchema,
  FeatureTypeSchema,
  FEATURE_TYPES,
  ItemStatusSchema,
} from './feature-types.js';
import { ReadingTotalsSchema } from './feature-reading.schemas.js';
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

/** Types added after revisions were already stored (ADR-033): absent there, meaning 0. */
const LATER_FEATURE_TYPES: readonly string[] = ['cabinet', 'ring'];

const CountsByFeatureType = z.object(
  Object.fromEntries(
    FEATURE_TYPES.map((t) => [
      t,
      LATER_FEATURE_TYPES.includes(t)
        ? z.number().int().min(0).default(0)
        : z.number().int().min(0),
    ]),
  ) as Record<(typeof FEATURE_TYPES)[number], z.ZodNumber>,
);

/** Totals per feature type and rule attributes (ADR-033/034); absent on revisions built before. */
export const FeatureGroupCountSchema = z.object({
  type: FeatureTypeSchema,
  kind: z.string().nullable(),
  role: CabinetRoleSchema.nullable(),
  status: ItemStatusSchema,
  count: z.number().int().min(0),
  /** Routes only: Σ drawn length in metres, 3 decimals. */
  lengthM: DecimalStringSchema.nullable(),
});
export type FeatureGroupCount = z.infer<typeof FeatureGroupCountSchema>;

export const DesignRevisionCountsSchema = z.object({
  features: CountsByFeatureType,
  /** Σ route lengths in metres (through the revision's drawing unit), 3 decimals. */
  routeLengthM: DecimalStringSchema,
  groups: z.array(FeatureGroupCountSchema).optional(),
  /** ADR-041: roles reading mode only; absent in legacy mode and on older revisions. */
  reading: ReadingTotalsSchema.optional(),
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
  /** Kind of the source file (ADR-040): one open revision and one published line per kind. */
  drawingKind: DrawingKindSchema,
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
  /** Frozen placement used for the build (ADR-035); null = as drawn. */
  placement: PlacementSchema.nullable().default(null),
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

/**
 * POST …/design-revisions/:revisionId/publish — publishes the PAIR (ADR-040): this draft and the
 * open draft of the other kind, together, with the same `revNo`. Both must pass every check.
 */
export const PublishDesignRevisionRequestSchema = z.object({
  /**
   * Required when text links still need review or the diff has conflicts, in either drawing.
   * After publishing they stay as they are (the revisions are locked).
   */
  acknowledgeOpenItems: z.boolean().default(false),
});
export type PublishDesignRevisionRequest = z.infer<typeof PublishDesignRevisionRequestSchema>;

/** Most names listed per side; `count`s stay exact. */
export const MAX_CABINET_NAMES_LISTED = 200;

const CabinetSideSchema = z.object({
  /** `sub` cabinets of the drawing's revision (main cabinets are not shared; ADR-041). */
  count: z.number().int().min(0),
  /** Cabinets with no name (feature `code` null): they cannot be matched. */
  unnamed: z.number().int().min(0),
  /** Names (as in this drawing) missing from the other drawing, sorted by cabinetNameKey. */
  missingInOther: z.array(z.string()).max(MAX_CABINET_NAMES_LISTED),
});

/**
 * Shared cabinets of the pair (ADR-040): matched by name (cabinetNameKey of the feature `code`);
 * ok when both counts are equal, no cabinet is unnamed and every name is in both drawings.
 */
export const CabinetsComparisonSchema = z.object({
  ok: z.boolean(),
  general: CabinetSideSchema,
  secondary: CabinetSideSchema,
});
export type CabinetsComparison = z.infer<typeof CabinetsComparisonSchema>;

/**
 * 409 details when publishing is refused (ADR-038, ADR-040). Checked in this order: the other
 * drawing has an open draft (`OTHER_DRAWING_MISSING`); then for this drawing, then the other:
 * coordinates (`CRS_UNKNOWN`, `PLACEMENT_MISSING`) and drawing errors (`PROBLEMS_OPEN`, blocking
 * problems only, ADR-041); then the shared cabinets of the pair (`CABINETS_MISMATCH`); last, open
 * items of both without acknowledgement (`OPEN_ITEMS`, summed). `drawingKind` names the drawing
 * that blocks.
 */
export const PublishBlockedDetailsSchema = z.discriminatedUnion('reason', [
  /** The other kind has no draft to publish with this one (ADR-040: both are published together). */
  z.object({ reason: z.literal('OTHER_DRAWING_MISSING'), drawingKind: DrawingKindSchema }),
  /** No placement frozen on the revision: its source CRS was never chosen (ADR-032 / ADR-035). */
  z.object({ reason: z.literal('CRS_UNKNOWN'), drawingKind: DrawingKindSchema }),
  /** The frozen placement has no control point in use (all excluded or none). */
  z.object({ reason: z.literal('PLACEMENT_MISSING'), drawingKind: DrawingKindSchema }),
  /** Drawing problems are left; every one must be fixed first (ADR-038). */
  z.object({
    reason: z.literal('PROBLEMS_OPEN'),
    drawingKind: DrawingKindSchema,
    problemCount: z.number().int().min(1),
  }),
  z.object({
    reason: z.literal('OPEN_ITEMS'),
    textLinksToReview: z.number().int().min(0),
    diffConflicts: z.number().int().min(0),
  }),
  /**
   * ADR-040/041 cross-drawing check, computed by the API from both drafts (the worker sees one
   * drawing): checked after both drawings' own blockers, before OPEN_ITEMS.
   */
  z.object({
    reason: z.literal('CABINETS_MISMATCH'),
    cabinets: CabinetsComparisonSchema,
  }),
]);
export type PublishBlockedDetails = z.infer<typeof PublishBlockedDetailsSchema>;

/** One drawing's sub cabinets: their names (feature `code`), null when unnamed. */
export function compareCabinets(
  general: readonly (string | null)[],
  secondary: readonly (string | null)[],
): CabinetsComparison {
  const byKey = (names: readonly (string | null)[]) => {
    const out = new Map<string, { name: string; n: number }>();
    for (const name of names) {
      if (name === null) continue;
      const key = cabinetNameKey(name);
      const seen = out.get(key);
      if (seen) seen.n += 1;
      else out.set(key, { name, n: 1 });
    }
    return out;
  };
  const g = byKey(general);
  const s = byKey(secondary);
  /** Names the other side lacks, or has fewer times (a name drawn twice must be drawn twice). */
  const missingIn = (
    from: Map<string, { name: string; n: number }>,
    other: Map<string, { name: string; n: number }>,
  ) =>
    [...from.entries()]
      .filter(([key, v]) => (other.get(key)?.n ?? 0) < v.n)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, v]) => v.name);
  const gMissing = missingIn(g, s);
  const sMissing = missingIn(s, g);
  const unnamed = (names: readonly (string | null)[]) => names.filter((n) => n === null).length;
  const side = (names: readonly (string | null)[], missing: string[]) => ({
    count: names.length,
    unnamed: unnamed(names),
    missingInOther: missing.slice(0, MAX_CABINET_NAMES_LISTED),
  });
  const ok =
    general.length === secondary.length &&
    unnamed(general) === 0 &&
    unnamed(secondary) === 0 &&
    gMissing.length === 0 &&
    sMissing.length === 0;
  return { ok, general: side(general, gMissing), secondary: side(secondary, sMissing) };
}

/**
 * GET …/design-revisions/:revisionId/publish-readiness — the checklist shown before «نشر»
 * (ADR-038). `ok` false on any of the first three locks the button; `open_items` not ok only asks
 * for the acknowledgement, as before.
 */
export const PUBLISH_CHECK_KEYS = [
  'crs_known',
  'control_point',
  'no_problems',
  'open_items',
  /** ADR-040: the other drawing has a draft that passes its own first three checks. */
  'other_drawing',
  /**
   * ADR-040/041: shared cabinets match by name and count in both drafts (CabinetsComparison).
   * Not ok while the other draft is missing.
   */
  'cabinets_match',
] as const;
export const PublishCheckKeySchema = z.enum(PUBLISH_CHECK_KEYS);
export type PublishCheckKey = z.infer<typeof PublishCheckKeySchema>;

export const PublishCheckSchema = z.object({
  key: PublishCheckKeySchema,
  ok: z.boolean(),
  /**
   * crs_known: null; control_point: points in use; no_problems: blocking problems left; open_items:
   * open (both drawings); other_drawing: blocking problems left in the other drawing's draft (null:
   * no draft); cabinets_match: unmatched cabinets = unnamed + missingInOther of both sides (null:
   * no other draft).
   */
  count: z.number().int().min(0).nullable(),
});
export type PublishCheck = z.infer<typeof PublishCheckSchema>;

export const PublishReadinessSchema = z.object({
  /** Always every key, in PUBLISH_CHECK_KEYS order. */
  checks: z.array(PublishCheckSchema).length(PUBLISH_CHECK_KEYS.length),
  /** Every check except open_items is ok and the revision is a draft. */
  canPublish: z.boolean(),
  /** Kind of this revision and the other drawing's open draft published with it (null: none). */
  drawingKind: DrawingKindSchema,
  otherRevisionId: z.uuid().nullable(),
  /** Open items exist: publishing needs `acknowledgeOpenItems: true`. */
  needsAcknowledgement: z.boolean(),
  /** The cabinets comparison behind `cabinets_match`; null without the other draft. */
  cabinets: CabinetsComparisonSchema.nullable().default(null),
  /** Non-blocking problems (warnings) of this drawing, shown next to the checklist. */
  warningCount: z.number().int().min(0).default(0),
});
export type PublishReadiness = z.infer<typeof PublishReadinessSchema>;

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
