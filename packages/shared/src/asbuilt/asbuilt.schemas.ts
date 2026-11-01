import { z } from 'zod';
import { DecimalStringSchema } from '../common/decimal.js';
import { FeatureTypeSchema, PointFeatureTypeSchema } from '../design/feature-types.js';
import { GpsFixSchema } from '../execution/execution.schemas.js';

/**
 * As-Built editing (Phase 4, ADR-030). Contract details: `docs/phase-4-contracts.md`.
 *
 * - The design revision is never changed. As-Built is separate state keyed by the same feature
 *   ids, plus features the supervisor added (`added = true`).
 * - Every edit is one immutable record sent through the Phase 3 sync path as the operation
 *   `asbuilt_edit.record` with its `clientOpId`; resends are idempotent.
 * - An edit changes nothing until it is approved on the web. Only approved edits make the
 *   As-Built state; the approved route length is what quantities read (Phase 5).
 * - Coordinates are metres in the project CRS (as in the offline bundle); never WGS 84.
 */

/** technical limits; the owner may tune them. */
export const ASBUILT_LIMITS = {
  /** Vertices of one route (same cap as arc flattening: 2048 segments). */
  maxRouteVertices: 2049,
  labelMaxLength: 200,
  noteMaxLength: 2000,
  reviewReasonMaxLength: 2000,
  /** |x| and |y| in project-CRS metres (UTM eastings/northings are well below). */
  maxAbsCoordinate: 100_000_000,
  /** Edits returned by one page of the review list. */
  maxListPage: 200,
} as const;

/** Layer names of the As-Built DXF export (build plan, Phase 4). */
export const ASBUILT_DXF_LAYERS = {
  edits: 'ASBUILT_EDITS',
  added: 'ASBUILT_ADDED',
} as const;

const Coordinate = z
  .number()
  .refine(Number.isFinite, 'Coordinate must be finite')
  .refine((v) => Math.abs(v) <= ASBUILT_LIMITS.maxAbsCoordinate, 'Coordinate out of range');
/** One position in project-CRS metres. */
export const ProjectXYSchema = z.tuple([Coordinate, Coordinate]);
export type ProjectXY = z.infer<typeof ProjectXYSchema>;

export const AsBuiltPointSchema = z.object({
  type: z.literal('Point'),
  coordinates: ProjectXYSchema,
});
export type AsBuiltPoint = z.infer<typeof AsBuiltPointSchema>;

export const AsBuiltLineStringSchema = z
  .object({
    type: z.literal('LineString'),
    coordinates: z.array(ProjectXYSchema).min(2).max(ASBUILT_LIMITS.maxRouteVertices),
  })
  .superRefine((line, ctx) => {
    // Two equal consecutive vertices make a zero-length segment: a route with no direction there.
    for (let i = 1; i < line.coordinates.length; i += 1) {
      const [ax, ay] = line.coordinates[i - 1] as ProjectXY;
      const [bx, by] = line.coordinates[i] as ProjectXY;
      if (ax === bx && ay === by) {
        ctx.addIssue({
          code: 'custom',
          path: ['coordinates', i],
          message: 'Repeated consecutive vertex',
        });
      }
    }
  });
export type AsBuiltLineString = z.infer<typeof AsBuiltLineStringSchema>;

export const AsBuiltGeometrySchema = z.union([AsBuiltPointSchema, AsBuiltLineStringSchema]);
export type AsBuiltGeometry = z.infer<typeof AsBuiltGeometrySchema>;

/**
 * Label text: trimmed, 1..200 characters, no control characters (they would break a DXF text
 * entity or a log line; they never come from a keyboard).
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
/** Free text (notes, reasons): line breaks and tabs allowed, other control characters not. */
// eslint-disable-next-line no-control-regex
const TEXT_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export const AsBuiltLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(ASBUILT_LIMITS.labelMaxLength)
  .refine((value) => !CONTROL_CHARS.test(value), 'Label must not contain control characters');

const NoteSchema = z
  .string()
  .trim()
  .min(1)
  .max(ASBUILT_LIMITS.noteMaxLength)
  .refine((value) => !TEXT_CONTROL_CHARS.test(value), 'Control characters');

/**
 * The five mobile tools (roadmap Phase 4):
 * - `move`: drag a point feature (box, hhi, joint, mh) to a new position.
 * - `reshape`: edit a route's vertices (grips: move, insert, remove).
 * - `add_route`: draw a new route (PLINE).
 * - `add_symbol`: insert a new point feature (INSERT) of an allowed point type.
 * - `label`: change the label text (DDEDIT).
 * There is no delete tool (not in the roadmap; ADR-030).
 */
export const ASBUILT_EDIT_KINDS = ['move', 'reshape', 'add_route', 'add_symbol', 'label'] as const;
export const AsBuiltEditKindSchema = z.enum(ASBUILT_EDIT_KINDS);
export type AsBuiltEditKind = z.infer<typeof AsBuiltEditKindSchema>;
export const ASBUILT_ADD_KINDS = ['add_route', 'add_symbol'] as const;

export function isAddKind(kind: AsBuiltEditKind): kind is 'add_route' | 'add_symbol' {
  return kind === 'add_route' || kind === 'add_symbol';
}

/**
 * The approved version the device drew on. Geometry and label have separate versions so a label
 * edit never makes a pending shape edit stale. 0 = the design as published (nothing approved yet).
 */
const BaseVersionSchema = z.number().int().min(0).max(1_000_000);

const Common = {
  /** Existing feature id, or a new client-generated UUID for `add_*`. */
  featureId: z.uuid(),
  /** The published revision the supervisor was looking at. */
  designRevisionId: z.uuid(),
  note: NoteSchema.nullable(),
  /** Evidence only; never used to place geometry. */
  gps: GpsFixSchema.nullable(),
};

export const AsBuiltEditPayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('move'),
    ...Common,
    baseVersion: BaseVersionSchema,
    geometry: AsBuiltPointSchema,
  }),
  z.object({
    kind: z.literal('reshape'),
    ...Common,
    baseVersion: BaseVersionSchema,
    geometry: AsBuiltLineStringSchema,
  }),
  z.object({
    kind: z.literal('add_route'),
    ...Common,
    geometry: AsBuiltLineStringSchema,
    label: AsBuiltLabelSchema.nullable(),
  }),
  z.object({
    kind: z.literal('add_symbol'),
    ...Common,
    featureType: PointFeatureTypeSchema,
    geometry: AsBuiltPointSchema,
    label: AsBuiltLabelSchema.nullable(),
  }),
  z.object({
    kind: z.literal('label'),
    ...Common,
    baseVersion: BaseVersionSchema,
    label: AsBuiltLabelSchema,
  }),
]);
export type AsBuiltEditPayload = z.infer<typeof AsBuiltEditPayloadSchema>;

export const RecordAsBuiltEditOpSchema = z.object({
  kind: z.literal('asbuilt_edit.record'),
  clientOpId: z.uuid(),
  /** Device clock when saved; evidence only. */
  capturedAt: z.iso.datetime({ offset: true }),
  payload: AsBuiltEditPayloadSchema,
});
export type RecordAsBuiltEditOp = z.infer<typeof RecordAsBuiltEditOpSchema>;

// ---------------------------------------------------------------------------------------------
// Server records

export const ASBUILT_EDIT_STATUSES = ['pending', 'approved', 'rejected'] as const;
export const AsBuiltEditStatusSchema = z.enum(ASBUILT_EDIT_STATUSES);
export type AsBuiltEditStatus = z.infer<typeof AsBuiltEditStatusSchema>;

/**
 * Server flags for the reviewer (never a rejection, ADR-024/030):
 * - BASE_OUTDATED: another edit of the same feature (geometry or label) was approved after the
 *   version this edit was drawn on. Approval is then refused (409 STALE_BASE): reject it, the
 *   supervisor redraws on the current state.
 * - REVISION_OUTDATED / FEATURE_REMOVED / CLOCK_AHEAD: as for execution updates.
 */
export const ASBUILT_EDIT_FLAGS = [
  'BASE_OUTDATED',
  'REVISION_OUTDATED',
  'FEATURE_REMOVED',
  'CLOCK_AHEAD',
] as const;
export const AsBuiltEditFlagSchema = z.enum(ASBUILT_EDIT_FLAGS);
export type AsBuiltEditFlag = z.infer<typeof AsBuiltEditFlagSchema>;

export const AsBuiltEditSchema = z.object({
  id: z.uuid(),
  clientOpId: z.uuid(),
  featureId: z.uuid(),
  kind: AsBuiltEditKindSchema,
  featureType: FeatureTypeSchema,
  designRevisionId: z.uuid(),
  /** null for `add_*` (nothing existed before). */
  baseVersion: z.number().int().min(0).nullable(),
  /** Proposed geometry (project CRS); null for `label`. */
  geometry: AsBuiltGeometrySchema.nullable(),
  /** Proposed label (`label`, `add_*`). */
  label: z.string().nullable(),
  /** ST_Length of the proposed route in metres (3 dp), computed by the server; null otherwise. */
  lengthM: DecimalStringSchema.nullable(),
  note: z.string().nullable(),
  userId: z.uuid(),
  userName: z.string(),
  deviceId: z.uuid(),
  capturedAt: z.iso.datetime({ offset: true }),
  receivedAt: z.iso.datetime({ offset: true }),
  flags: z.array(AsBuiltEditFlagSchema),
  status: AsBuiltEditStatusSchema,
  reviewReason: z.string().nullable(),
  reviewedBy: z.uuid().nullable(),
  reviewedAt: z.iso.datetime({ offset: true }).nullable(),
  /** Version this edit created when approved (geometry or label version); null otherwise. */
  approvedVersion: z.number().int().min(1).nullable(),
});
export type AsBuiltEdit = z.infer<typeof AsBuiltEditSchema>;

/**
 * Approved As-Built state of one feature that differs from the design (an approved edit exists)
 * or was added. A feature absent from this list is As-Built = design.
 */
export const AsBuiltFeatureStateSchema = z.object({
  featureId: z.uuid(),
  featureType: FeatureTypeSchema,
  added: z.boolean(),
  geometry: AsBuiltGeometrySchema,
  /** Approved route length in metres (ST_Length, 3 dp); null for points. */
  lengthM: DecimalStringSchema.nullable(),
  /** Approved As-Built label; null when never changed (the design text applies). */
  label: z.string().nullable(),
  geometryVersion: z.number().int().min(0),
  labelVersion: z.number().int().min(0),
});
export type AsBuiltFeatureState = z.infer<typeof AsBuiltFeatureStateSchema>;

// ---------------------------------------------------------------------------------------------
// Web review (approve / reject each edit)

export const AsBuiltEditListQuerySchema = z.object({
  status: AsBuiltEditStatusSchema.optional(),
  featureId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(ASBUILT_LIMITS.maxListPage).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
export type AsBuiltEditListQuery = z.infer<typeof AsBuiltEditListQuerySchema>;

export const AsBuiltEditListResponseSchema = z.object({
  items: z.array(AsBuiltEditSchema),
  total: z.number().int().min(0),
});
export type AsBuiltEditListResponse = z.infer<typeof AsBuiltEditListResponseSchema>;

/** What the comparison view draws: design (dashed) under the approved state and the proposal. */
export const AsBuiltEditDetailSchema = z.object({
  edit: AsBuiltEditSchema,
  crsEpsg: z.number().int(),
  /** The feature in the edit's design revision; null for an added feature. */
  design: z
    .object({
      revisionId: z.uuid(),
      code: z.string().nullable(),
      layer: z.string(),
      geometry: AsBuiltGeometrySchema,
      lengthM: DecimalStringSchema.nullable(),
    })
    .nullable(),
  /** Approved As-Built state now; null when nothing is approved for this feature yet. */
  current: AsBuiltFeatureStateSchema.nullable(),
  /** True when the edit is pending and its base version is still the current one. */
  approvable: z.boolean(),
});
export type AsBuiltEditDetail = z.infer<typeof AsBuiltEditDetailSchema>;

export const RejectAsBuiltEditRequestSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1)
    .max(ASBUILT_LIMITS.reviewReasonMaxLength)
    .refine((value) => !TEXT_CONTROL_CHARS.test(value), 'Control characters'),
});
export type RejectAsBuiltEditRequest = z.infer<typeof RejectAsBuiltEditRequestSchema>;

/**
 * Reasons in `details.reason` of a refused review:
 * - 409 CONFLICT `NOT_PENDING`: already approved or rejected (a review is final).
 * - 409 CONFLICT `STALE_BASE`: another edit of this feature was approved since this one was drawn.
 * - 403 FORBIDDEN `SELF_REVIEW`: the reviewer recorded the edit.
 */
export const ASBUILT_REVIEW_REFUSALS = ['NOT_PENDING', 'STALE_BASE', 'SELF_REVIEW'] as const;
export type AsBuiltReviewRefusal = (typeof ASBUILT_REVIEW_REFUSALS)[number];

// ---------------------------------------------------------------------------------------------
// Approved lengths (read model for Phase 5 quantities)

export const AsBuiltRouteLengthSchema = z.object({
  featureId: z.uuid(),
  code: z.string().nullable(),
  added: z.boolean(),
  /** Design length in the latest published revision; null for an added route. */
  designLengthM: DecimalStringSchema.nullable(),
  /** The length quantities must use: approved As-Built if any, otherwise the design length. */
  lengthM: DecimalStringSchema,
  source: z.enum(['design', 'asbuilt']),
  geometryVersion: z.number().int().min(0),
});
export type AsBuiltRouteLength = z.infer<typeof AsBuiltRouteLengthSchema>;

export const AsBuiltLengthsResponseSchema = z.object({
  /** Latest published revision, or null when nothing is published (then `routes` is empty). */
  revisionId: z.uuid().nullable(),
  routes: z.array(AsBuiltRouteLengthSchema),
});
export type AsBuiltLengthsResponse = z.infer<typeof AsBuiltLengthsResponseSchema>;

export const AsBuiltStateResponseSchema = z.object({
  revisionId: z.uuid().nullable(),
  crsEpsg: z.number().int(),
  features: z.array(AsBuiltFeatureStateSchema),
});
export type AsBuiltStateResponse = z.infer<typeof AsBuiltStateResponseSchema>;

// ---------------------------------------------------------------------------------------------
// DXF export (CAD worker)

export const ASBUILT_EXPORT_STATUSES = ['queued', 'processing', 'done', 'failed'] as const;
export const AsBuiltExportStatusSchema = z.enum(ASBUILT_EXPORT_STATUSES);
export type AsBuiltExportStatus = z.infer<typeof AsBuiltExportStatusSchema>;

export const AsBuiltExportSchema = z.object({
  id: z.uuid(),
  revisionId: z.uuid(),
  status: AsBuiltExportStatusSchema,
  requestedBy: z.uuid(),
  requestedAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
  /** Counts written by the worker; null until done. */
  stats: z
    .object({
      designFeatures: z.number().int().min(0),
      editedFeatures: z.number().int().min(0),
      addedFeatures: z.number().int().min(0),
    })
    .nullable(),
  sizeBytes: z.number().int().min(0).nullable(),
  /** Error code when failed (e.g. NO_PUBLISHED_REVISION, MAX_ATTEMPTS_EXCEEDED). */
  error: z.string().nullable(),
});
export type AsBuiltExport = z.infer<typeof AsBuiltExportSchema>;

export const AsBuiltExportListResponseSchema = z.object({ items: z.array(AsBuiltExportSchema) });
export type AsBuiltExportListResponse = z.infer<typeof AsBuiltExportListResponseSchema>;
