import { z } from 'zod';
import { DrawingUnitSchema } from '../cad/drawing-units.js';
import { DrawingKindSchema } from '../cad/drawing-kind.schemas.js';
import { MappingRuleSchema } from '../cad/cad-mapping.schemas.js';
import { cabinetNameKey } from '../cad/text-roles.js';
import { PlacementSchema } from '../cad/placement.schemas.js';
import {
  FrozenInstallationSchema,
  InstallationIssueSchema,
  InstallationReportSchema,
  MAX_INSTALLATION_ISSUES_LISTED,
} from '../cad/installation.schemas.js';
import {
  BoxTypeIssueSchema,
  BoxTypesReportSchema,
  FrozenBoxTypesSchema,
  MAX_BOX_TYPE_ISSUES_LISTED,
} from '../cad/box-types.schemas.js';
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
  /** ADR-049 part B: the drawing (a line of versions) this revision belongs to, its site and number. */
  drawingId: z.uuid(),
  siteId: z.uuid().nullable(),
  drawingOrdinal: z.number().int().min(1),
  /** Assigned on publish (1, 2, …), shared by the revisions of one site publication; null before. */
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
  /**
   * Frozen installation answer and trench marks (ADR-042 part D); General only. null on a
   * Secondary and on revisions built before migration 0022 (a General then reads as unanswered).
   */
  installation: FrozenInstallationSchema.nullable().default(null),
  /**
   * Frozen box-type choices (ADR-043); Secondary only. null on a General and on revisions built
   * before migration 0023. The shape gallery is served apart (GET …/box-types), not here.
   */
  boxTypes: FrozenBoxTypesSchema.nullable().default(null),
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
 * POST …/design-revisions/:revisionId/publish — publishes the SITE (ADR-049 part B): every draft of
 * the revision's site, together, with the same `revNo`. The site must pass every check.
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
 * Shared cabinets of one General and one Secondary (ADR-040): matched by name (cabinetNameKey of
 * the feature `code`); ok when both counts are equal, no cabinet is unnamed and every name is in
 * both drawings. The site check (`SiteCabinetsComparison`) builds on the same rule.
 */
export const CabinetsComparisonSchema = z.object({
  ok: z.boolean(),
  general: CabinetSideSchema,
  secondary: CabinetSideSchema,
});
export type CabinetsComparison = z.infer<typeof CabinetsComparisonSchema>;

/**
 * Cabinets of one SITE (ADR-049 part B): the General's sub cabinets must be the disjoint union of
 * the sub cabinets of the site's Secondaries. ok when no cabinet is unnamed, no name is in two
 * Secondaries, none is missing in the General or in every Secondary, and counts agree.
 */
export const SiteCabinetsComparisonSchema = z.object({
  ok: z.boolean(),
  general: z.object({
    drawingId: z.uuid().nullable(),
    count: z.number().int().min(0),
    unnamed: z.number().int().min(0),
  }),
  secondaries: z.array(
    z.object({
      drawingId: z.uuid(),
      ordinal: z.number().int().min(1),
      side: CabinetSideSchema,
    }),
  ),
  /** Names drawn in more than one Secondary of the site. */
  inSeveralSecondaries: z.array(z.string()).max(MAX_CABINET_NAMES_LISTED),
  /** Names of the Secondaries the General lacks. */
  missingInGeneral: z.array(z.string()).max(MAX_CABINET_NAMES_LISTED),
  /** Names of the General that no Secondary has. */
  missingInSecondaries: z.array(z.string()).max(MAX_CABINET_NAMES_LISTED),
});
export type SiteCabinetsComparison = z.infer<typeof SiteCabinetsComparisonSchema>;

/** A cabinet name that another site of the same work order already has (owner rule, 2026-11-18). */
export const CabinetInOtherSiteSchema = z.object({
  name: z.string(),
  otherSiteId: z.uuid(),
  otherSiteName: z.string(),
});
export type CabinetInOtherSite = z.infer<typeof CabinetInOtherSiteSchema>;

/** Why a drawing of the site is not ready to be published with the others. */
export const DRAWING_NOT_READY_STATES = ['no_revision', 'building', 'queued', 'failed'] as const;
export type DrawingNotReadyState = (typeof DRAWING_NOT_READY_STATES)[number];

const DrawingRef = {
  drawingKind: DrawingKindSchema,
  drawingId: z.uuid(),
  ordinal: z.number().int().min(1),
};

/**
 * 409 details when publishing is refused (ADR-038, ADR-040, ADR-049 part B). Order of checks: the
 * drawing has a site (`SITE_UNASSIGNED`); the site has a General and a Secondary
 * (`SITE_INCOMPLETE`); every drawing of the site has a draft or a published revision and none is
 * building (`DRAWING_NOT_READY`); for each draft in order General, Secondary 1, 2, …: coordinates
 * (`CRS_UNKNOWN`, `PLACEMENT_MISSING`), drawing errors (`PROBLEMS_OPEN`), installation
 * (`INSTALLATION_UNCLEAR`, General), box types (`BOX_TYPES_UNCLEAR`, Secondary); then the cabinets
 * of the site (`CABINETS_MISMATCH`) and against other sites (`CABINET_IN_OTHER_SITE`); last open
 * items of the drafts without acknowledgement (`OPEN_ITEMS`, summed).
 */
export const PublishBlockedDetailsSchema = z.discriminatedUnion('reason', [
  /** The drawing is not linked to a site («بدون موقع»): link it first. */
  z.object({ reason: z.literal('SITE_UNASSIGNED'), ...DrawingRef }),
  /** The site lacks a General or a Secondary (not withdrawn). */
  z.object({
    reason: z.literal('SITE_INCOMPLETE'),
    siteId: z.uuid(),
    missingKinds: z.array(DrawingKindSchema).min(1),
  }),
  /** A drawing of the site has no draft and no published revision, or is still building. */
  z.object({
    reason: z.literal('DRAWING_NOT_READY'),
    ...DrawingRef,
    state: z.enum(DRAWING_NOT_READY_STATES),
  }),
  /** No placement frozen on the revision: its source CRS was never chosen (ADR-032 / ADR-035). */
  z.object({ reason: z.literal('CRS_UNKNOWN'), ...DrawingRef }),
  /** The frozen placement has no control point in use (all excluded or none). */
  z.object({ reason: z.literal('PLACEMENT_MISSING'), ...DrawingRef }),
  /** Drawing problems are left; every one must be fixed first (ADR-038). */
  z.object({
    reason: z.literal('PROBLEMS_OPEN'),
    ...DrawingRef,
    problemCount: z.number().int().min(1),
  }),
  /**
   * ADR-042 part D, General only: the installation question is unanswered, `has_trench` has no
   * mark, or a mark does not fit its route (`evaluateInstallation`). Anything unclear is an error.
   */
  z.object({
    reason: z.literal('INSTALLATION_UNCLEAR'),
    ...DrawingRef,
    drawingKind: z.literal('general'),
    issueCount: z.number().int().min(1),
    issues: z.array(InstallationIssueSchema).max(MAX_INSTALLATION_ISSUES_LISTED),
  }),
  /**
   * ADR-043, Secondary in roles mode only: a box shape has no work-order line chosen, a chosen line
   * no longer exists, or shapes could not be read (`evaluateBoxTypes`). Anything unclear is an error.
   */
  z.object({
    reason: z.literal('BOX_TYPES_UNCLEAR'),
    ...DrawingRef,
    drawingKind: z.literal('secondary'),
    issueCount: z.number().int().min(1),
    issues: z.array(BoxTypeIssueSchema).max(MAX_BOX_TYPE_ISSUES_LISTED),
  }),
  z.object({
    reason: z.literal('OPEN_ITEMS'),
    textLinksToReview: z.number().int().min(0),
    diffConflicts: z.number().int().min(0),
  }),
  /** ADR-049: the General's sub cabinets are not the union of the Secondaries' (computed by the API). */
  z.object({
    reason: z.literal('CABINETS_MISMATCH'),
    cabinets: SiteCabinetsComparisonSchema,
  }),
  /** Owner rule: a cabinet name belongs to one site of the work order only. */
  z.object({
    reason: z.literal('CABINET_IN_OTHER_SITE'),
    cabinets: z.array(CabinetInOtherSiteSchema).min(1).max(MAX_CABINET_NAMES_LISTED),
  }),
]);
export type PublishBlockedDetails = z.infer<typeof PublishBlockedDetailsSchema>;

type CabinetCount = Map<string, { name: string; n: number }>;

const countByKey = (names: readonly (string | null)[]): CabinetCount => {
  const out: CabinetCount = new Map();
  for (const name of names) {
    if (name === null) continue;
    const key = cabinetNameKey(name);
    const seen = out.get(key);
    if (seen) seen.n += 1;
    else out.set(key, { name, n: 1 });
  }
  return out;
};

const sortedNames = (entries: [string, { name: string }][]): string[] =>
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v.name);

/** Names of `from` that `other` lacks, or has fewer times (a name drawn twice must be drawn twice). */
const missingIn = (from: CabinetCount, other: CabinetCount): string[] =>
  sortedNames([...from.entries()].filter(([key, v]) => (other.get(key)?.n ?? 0) < v.n));

const unnamedIn = (names: readonly (string | null)[]): number =>
  names.filter((n) => n === null).length;

/** One drawing's sub cabinets: their names (feature `code`), null when unnamed. */
export function compareCabinets(
  general: readonly (string | null)[],
  secondary: readonly (string | null)[],
): CabinetsComparison {
  const g = countByKey(general);
  const s = countByKey(secondary);
  const gMissing = missingIn(g, s);
  const sMissing = missingIn(s, g);
  const side = (names: readonly (string | null)[], missing: string[]) => ({
    count: names.length,
    unnamed: unnamedIn(names),
    missingInOther: missing.slice(0, MAX_CABINET_NAMES_LISTED),
  });
  const ok =
    general.length === secondary.length &&
    unnamedIn(general) === 0 &&
    unnamedIn(secondary) === 0 &&
    gMissing.length === 0 &&
    sMissing.length === 0;
  return { ok, general: side(general, gMissing), secondary: side(secondary, sMissing) };
}

/**
 * The General's sub cabinets against the Secondaries' of one site (ADR-049 part B): the General
 * must be the disjoint union of the Secondaries (a name in two Secondaries is an error; a name
 * drawn twice in one drawing must be drawn twice in the General).
 */
export function compareSiteCabinets(
  general: { drawingId: string | null; names: readonly (string | null)[] },
  secondaries: readonly {
    drawingId: string;
    ordinal: number;
    names: readonly (string | null)[];
  }[],
): SiteCabinetsComparison {
  const g = countByKey(general.names);
  const maps = secondaries.map((s) => countByKey(s.names));
  const union: CabinetCount = new Map();
  const holders = new Map<string, number>();
  for (const map of maps) {
    for (const [key, v] of map) {
      const seen = union.get(key);
      if (seen) seen.n += v.n;
      else union.set(key, { name: v.name, n: v.n });
      holders.set(key, (holders.get(key) ?? 0) + 1);
    }
  }
  const inSeveral = sortedNames(
    [...union.entries()].filter(([key]) => (holders.get(key) ?? 0) > 1),
  );
  const missingInGeneral = missingIn(union, g);
  const missingInSecondaries = missingIn(g, union);
  const sides = secondaries.map((s, index) => ({
    drawingId: s.drawingId,
    ordinal: s.ordinal,
    side: {
      count: s.names.length,
      unnamed: unnamedIn(s.names),
      // Names of this Secondary the General lacks.
      missingInOther: missingIn(maps[index] ?? new Map(), g).slice(0, MAX_CABINET_NAMES_LISTED),
    },
  }));
  const total = secondaries.reduce((sum, s) => sum + s.names.length, 0);
  const ok =
    general.names.length === total &&
    unnamedIn(general.names) === 0 &&
    sides.every((s) => s.side.unnamed === 0) &&
    inSeveral.length === 0 &&
    missingInGeneral.length === 0 &&
    missingInSecondaries.length === 0;
  return {
    ok,
    general: {
      drawingId: general.drawingId,
      count: general.names.length,
      unnamed: unnamedIn(general.names),
    },
    secondaries: sides,
    inSeveralSecondaries: inSeveral.slice(0, MAX_CABINET_NAMES_LISTED),
    missingInGeneral: missingInGeneral.slice(0, MAX_CABINET_NAMES_LISTED),
    missingInSecondaries: missingInSecondaries.slice(0, MAX_CABINET_NAMES_LISTED),
  };
}

/**
 * GET …/design-revisions/:revisionId/publish-readiness and GET …/sites/:siteId/publish-readiness
 * — the checklist shown before «نشر» (ADR-038, ADR-049 part B). Every check is the site's: the
 * counts add up over the drafts that would be published together. `ok` false on any check but
 * `open_items` locks the button; `open_items` not ok only asks for the acknowledgement.
 */
export const PUBLISH_CHECK_KEYS = [
  'crs_known',
  'control_point',
  'no_problems',
  'open_items',
  /**
   * ADR-049: the site has a General and a Secondary, and every drawing of it has a draft or a
   * published revision (none building). Replaces `other_drawing`.
   */
  'site_drawings',
  /**
   * ADR-040/041/049: the General's sub cabinets are the disjoint union of the Secondaries'
   * (SiteCabinetsComparison).
   */
  'cabinets_match',
  /** Owner rule: no cabinet name of the site is also in another site of the work order. */
  'cabinets_other_site',
  /**
   * ADR-042 part D: the General's installation is clear (`evaluateInstallation` ok); count null
   * when no General draft is in the site publication.
   */
  'installation',
  /**
   * ADR-043: the Secondaries' box types are clear (`evaluateBoxTypes` ok); count null when no
   * Secondary draft is in the site publication or in legacy mode.
   */
  'box_types',
] as const;
export const PublishCheckKeySchema = z.enum(PUBLISH_CHECK_KEYS);
export type PublishCheckKey = z.infer<typeof PublishCheckKeySchema>;

export const PublishCheckSchema = z.object({
  key: PublishCheckKeySchema,
  ok: z.boolean(),
  /**
   * crs_known: null; control_point: points in use (smallest over the drafts); no_problems: blocking
   * problems left (sum); open_items: open (sum); site_drawings: drawings of the site not ready;
   * cabinets_match: unmatched cabinets; cabinets_other_site: names found in other sites;
   * installation / box_types: issues (null when it does not apply).
   */
  count: z.number().int().min(0).nullable(),
});
export type PublishCheck = z.infer<typeof PublishCheckSchema>;

/** One drawing of the site inside the checklist: its own checks (a draft, else the published one). */
export const PublishDrawingReadinessSchema = z.object({
  drawingId: z.uuid(),
  drawingKind: DrawingKindSchema,
  ordinal: z.number().int().min(1),
  /** The draft that will be published; null when the drawing has none (published or not ready). */
  draftRevisionId: z.uuid().nullable(),
  state: z.enum(['draft', 'published', 'not_ready']),
  /** crs_known, control_point, no_problems, installation, box_types of this drawing's draft. */
  checks: z.array(PublishCheckSchema),
  warningCount: z.number().int().min(0).default(0),
  /** ADR-042: the installation report behind `installation`; null on a Secondary. */
  installation: InstallationReportSchema.nullable().default(null),
  /** ADR-043: the box-types report behind `box_types`; null on a General / legacy-mode Secondary. */
  boxTypes: BoxTypesReportSchema.nullable().default(null),
});
export type PublishDrawingReadiness = z.infer<typeof PublishDrawingReadinessSchema>;

export const PublishReadinessSchema = z.object({
  /** The site whose drafts are published together; null when the drawing has no site. */
  siteId: z.uuid().nullable(),
  /** Always every key, in PUBLISH_CHECK_KEYS order. */
  checks: z.array(PublishCheckSchema).length(PUBLISH_CHECK_KEYS.length),
  /** Every check except open_items is ok and the site has at least one draft. */
  canPublish: z.boolean(),
  /** The revision the page was asked for (null on the site route) and its kind. */
  revisionId: z.uuid().nullable().default(null),
  drawingKind: DrawingKindSchema.nullable().default(null),
  /** Drafts that «نشر» publishes together (one `revNo`). */
  siteRevisionIds: z.array(z.uuid()).default([]),
  drawings: z.array(PublishDrawingReadinessSchema).default([]),
  /** Open items exist: publishing needs `acknowledgeOpenItems: true`. */
  needsAcknowledgement: z.boolean(),
  /** The cabinets comparison behind `cabinets_match`; null while the site has no General. */
  cabinets: SiteCabinetsComparisonSchema.nullable().default(null),
  /** Cabinet names found in another site of the work order (`cabinets_other_site`). */
  cabinetsInOtherSites: z.array(CabinetInOtherSiteSchema).default([]),
  /** Non-blocking problems (warnings) of the drafts, shown next to the checklist. */
  warningCount: z.number().int().min(0).default(0),
  /**
   * ADR-045: checks whose step is switched off (`installation`, `box_types`). Such a check is ok
   * unless it still reports an error (`READING_ROLES_MISSING` on `box_types`); the web hides it
   * while ok.
   */
  switchedOff: z.array(PublishCheckKeySchema).default([]),
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
