import { z } from 'zod';
import {
  AsBuiltEditSchema,
  AsBuiltFeatureStateSchema,
  RecordAsBuiltEditOpSchema,
} from '../asbuilt/asbuilt.schemas.js';
import { ProposePlacementPointOpSchema } from '../cad/gps-proposal.schemas.js';
import { DecimalStringSchema } from '../common/decimal.js';
import { FeatureTypeSchema } from '../design/feature-types.js';
import { WorkTypeSchema } from '../work-orders/work-order.schemas.js';
import { ItemGroupSchema } from '../contracts/item-groups.js';
import { EXECUTION_LIMITS } from './execution.constants.js';
import { ElementGroupsSchema } from './element-groups.js';
import { ExecutionUpdateSchema, RecordUpdatePayloadSchema } from './execution.schemas.js';

/**
 * Sync protocol (ADR-024). Mobile → server: `POST /projects/:projectId/sync/push` with an outbox
 * batch. Server → mobile: `GET …/sync/bootstrap` (offline bundle) and `GET …/sync/changes`
 * (updates in the caller's scope after a server cursor). Photos travel separately through the
 * resumable upload `…/sync/photos/:photoId`.
 */

export const OP_KINDS = [
  'execution_update.record',
  'asbuilt_edit.record',
  'placement_point.propose',
] as const;
export const OpKindSchema = z.enum(OP_KINDS);
export type OpKind = z.infer<typeof OpKindSchema>;

export const RecordUpdateOpSchema = z.object({
  kind: z.literal('execution_update.record'),
  clientOpId: z.uuid(),
  /** Device clock when the supervisor saved; kept as evidence, never used for ordering. */
  capturedAt: z.iso.datetime({ offset: true }),
  payload: RecordUpdatePayloadSchema,
});
export type RecordUpdateOp = z.infer<typeof RecordUpdateOpSchema>;

/**
 * Union of every operation a device may send (Phase 4 adds As-Built edits, ADR-030; ADR-037 adds
 * supervisor GPS point proposals).
 */
export const SyncOpSchema = z.discriminatedUnion('kind', [
  RecordUpdateOpSchema,
  RecordAsBuiltEditOpSchema,
  ProposePlacementPointOpSchema,
]);
export type SyncOp = z.infer<typeof SyncOpSchema>;

export const SyncPushRequestSchema = z
  .object({
    deviceId: z.uuid(),
    ops: z.array(SyncOpSchema).min(1).max(EXECUTION_LIMITS.maxOpsPerPush),
  })
  .superRefine((request, ctx) => {
    const ids = new Set(request.ops.map((op) => op.clientOpId));
    if (ids.size !== request.ops.length) {
      ctx.addIssue({ code: 'custom', path: ['ops'], message: 'Duplicate clientOpId in one batch' });
    }
  });
export type SyncPushRequest = z.infer<typeof SyncPushRequestSchema>;

/**
 * Why an operation was refused for good. The device must not resend it unchanged; it shows the
 * operation in the "needs attention" list.
 */
export const OP_REJECTION_CODES = [
  /** The same clientOpId was already used with a different payload or by another user/device. */
  'OP_ID_REUSED',
  /** A photoId of this op belongs to another update. */
  'PHOTO_ID_REUSED',
  'FEATURE_NOT_FOUND',
  /** The feature is outside the caller's sites (ADR-054). */
  'FEATURE_OUT_OF_SCOPE',
  /** designRevisionId is not a published revision of this project containing the feature. */
  'REVISION_NOT_PUBLISHED',
  'ITEM_NOT_FOUND',
  /** The item's work type differs from the update's activity. */
  'ITEM_WORK_TYPE_MISMATCH',
  // ---- As-Built edits (Phase 4, ADR-030) ----
  /** `add_*` with a featureId that already exists (design or an earlier add). */
  'FEATURE_ID_REUSED',
  /** Tool does not fit the feature: `move` on a route, `reshape` on a point. */
  'GEOMETRY_KIND_MISMATCH',
  /** Geometry PostGIS finds invalid or a route of zero length. */
  'GEOMETRY_INVALID',
  // ---- GPS point proposals (ADR-037) ----
  /** The item is not a cabinet, handhole, manhole, joint or box. */
  'FEATURE_TYPE_NOT_ALLOWED',
  /** The fix is reported worse than GPS_PROPOSAL_MAX_ACCURACY_M (the phone should never send it). */
  'GPS_ACCURACY_TOO_LOW',
  // ---- Contractor per work line (ADR-052) ----
  /** The contractor line is not a contractor of that work-order line in this project. */
  'CONTRACTOR_LINE_NOT_FOUND',
  /**
   * The quantity is above what is left of the contractor's quantity (its quantity minus pending
   * and approved work on it; rejected work does not count). The admin raises the quantity first.
   */
  'CONTRACTOR_QUANTITY_EXCEEDED',
  // ---- Groups and dimensions (ADR-056) ----
  /** A digging m3 line (catalog `needsDimensions`) without its length × width × depth. */
  'DIMENSIONS_REQUIRED',
  /** Dimensions on a line that takes none. */
  'DIMENSIONS_NOT_ALLOWED',
  /** `drawingId` of a «التخطيط» update is not a published drawing of the project. */
  'DRAWING_NOT_FOUND',
  /** The drawing of a «التخطيط» update is outside the caller's sites (ADR-054). */
  'DRAWING_OUT_OF_SCOPE',
  // ---- Work date (ADR-057) ----
  /** The work date is after today (Africa/Cairo, server clock on receipt). */
  'WORK_DATE_IN_FUTURE',
  /** A contractor picked on a work line was registered on the work order after the work date. */
  'CONTRACTOR_NOT_REGISTERED_ON_DATE',
  // ---- Secondary drawings (ADR-058) ----
  /**
   * The cabinet is shared by the General and a Secondary of the site (same name) and its work is
   * already recorded on it in the other drawing (first drawing with non-rejected work wins).
   */
  'CABINET_RECORDED_IN_OTHER_DRAWING',
] as const;
export const OpRejectionCodeSchema = z.enum(OP_REJECTION_CODES);
export type OpRejectionCode = z.infer<typeof OpRejectionCodeSchema>;

export const OpResultSchema = z.discriminatedUnion('outcome', [
  /**
   * `updateId` is the id of the record the op created: an execution update, an As-Built edit for
   * `asbuilt_edit.record`, or a GPS point proposal for `placement_point.propose` (name kept from
   * Phase 3 so devices in the field stay compatible).
   */
  z.object({
    clientOpId: z.uuid(),
    outcome: z.literal('applied'),
    updateId: z.uuid(),
  }),
  /** Already applied earlier (a resend): same result as the first time. */
  z.object({
    clientOpId: z.uuid(),
    outcome: z.literal('duplicate'),
    updateId: z.uuid(),
  }),
  z.object({
    clientOpId: z.uuid(),
    outcome: z.literal('rejected'),
    code: OpRejectionCodeSchema,
  }),
]);
export type OpResult = z.infer<typeof OpResultSchema>;

export const SyncPushResponseSchema = z.object({
  serverTime: z.iso.datetime({ offset: true }),
  results: z.array(OpResultSchema),
});
export type SyncPushResponse = z.infer<typeof SyncPushResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Pull

/** Opaque server cursor (a decimal sequence number); never derived from a device clock. */
export const SyncCursorSchema = z.string().regex(/^(0|[1-9]\d{0,18})$/, 'Invalid cursor');

export const SyncChangesQuerySchema = z.object({
  cursor: SyncCursorSchema.default('0'),
  limit: z.coerce.number().int().min(1).max(EXECUTION_LIMITS.maxPullPage).default(200),
});
export type SyncChangesQuery = z.infer<typeof SyncChangesQuerySchema>;

export const SyncChangesResponseSchema = z.object({
  serverTime: z.iso.datetime({ offset: true }),
  /** Pass back as `cursor` for the next page. */
  cursor: SyncCursorSchema,
  hasMore: z.boolean(),
  updates: z.array(ExecutionUpdateSchema),
  /**
   * As-Built edits in the caller's scope changed after the cursor (recorded or reviewed), on the
   * same server sequence as `updates` (ADR-030). Absent from Phase 3 servers → empty.
   */
  asBuiltEdits: z.array(AsBuiltEditSchema).default([]),
});
export type SyncChangesResponse = z.infer<typeof SyncChangesResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Offline bundle

/** Coordinates are metres in the project CRS (`crsEpsg`), as stored; never WGS 84. */
const ProjectXY = z.tuple([z.number(), z.number()]);
export const OfflineFeatureGeometrySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('Point'), coordinates: ProjectXY }),
  z.object({ type: z.literal('LineString'), coordinates: z.array(ProjectXY).min(2) }),
]);
export type OfflineFeatureGeometry = z.infer<typeof OfflineFeatureGeometrySchema>;

export const OfflineFeatureSchema = z.object({
  id: z.uuid(),
  type: FeatureTypeSchema,
  code: z.string().nullable(),
  layer: z.string(),
  geometry: OfflineFeatureGeometrySchema,
  /** Design length of a route in metres; null for point features. */
  lengthM: DecimalStringSchema.nullable(),
});
export type OfflineFeature = z.infer<typeof OfflineFeatureSchema>;

/**
 * A contractor the supervisor may pick on a work line (ADR-052): one contractor line of the
 * work-order line. Never a price (the phone shows no prices).
 */
export const CatalogContractorSchema = z.object({
  contractorLineId: z.uuid(),
  contractorId: z.uuid(),
  contractorName: z.string(),
  /** Scope of work («نطاق الشغل»); null = the whole line. */
  scope: z.string().nullable(),
  /** The contractor's quantity on this line and scope. */
  quantity: DecimalStringSchema,
  /** Pending + approved work on this contractor line (any user) when the bundle was built. */
  recordedQuantity: DecimalStringSchema,
  /**
   * ADR-057: his registration date on the work order. He is not offered on an update whose work
   * date is earlier (`CONTRACTOR_NOT_REGISTERED_ON_DATE`). Null from a server built before it.
   */
  registeredOn: z.iso.date().nullable().default(null),
});
export type CatalogContractor = z.infer<typeof CatalogContractorSchema>;

/** A work-order item the supervisor may record against (no prices: ADR-011 visibility pending). */
export const CatalogItemSchema = z.object({
  id: z.uuid(),
  workOrderId: z.uuid(),
  workOrderNumber: z.string(),
  lineNo: z.number().int(),
  code: z.string(),
  description: z.string(),
  unit: z.string(),
  /** Contract quantity of the work order. */
  quantity: DecimalStringSchema,
  workType: WorkTypeSchema.nullable(),
  /** Sum of all non-rejected update lines (any user) when the bundle was built. */
  recordedQuantity: DecimalStringSchema,
  /** Contractors on this line (ADR-052); «self» is always offered besides them. */
  contractors: z.array(CatalogContractorSchema).default([]),
  /** ADR-048 groups of the contract line (rule or admin choice); null when ungrouped. ADR-056. */
  group: ItemGroupSchema.nullable().default(null),
  /** ADR-056: the supervisor types length × width × depth and the quantity is their product. */
  needsDimensions: z.boolean().default(false),
});
export type CatalogItem = z.infer<typeof CatalogItemSchema>;

/**
 * Capabilities that depend on Phase 2 data. `unavailable` means the device must not invent them:
 * no suggested quantity, and only the generic photo requirement (ADR-023).
 */
export const CapabilityStatusSchema = z.enum(['available', 'unavailable']);

export const PhotoRequirementSchema = z.object({
  key: z.string(),
  /** Minimum number of photos for this key. */
  minCount: z.number().int().min(1),
});
export type PhotoRequirement = z.infer<typeof PhotoRequirementSchema>;

/**
 * GET …/sync/bootstrap?drawingId= (ADR-049 part B): the drawing whose published revision and
 * features the bundle carries. Without it the bundle carries the General published last (as
 * before), so a device that does not know drawings keeps working.
 */
export const SyncBootstrapQuerySchema = z.object({ drawingId: z.uuid().optional() });
export type SyncBootstrapQuery = z.infer<typeof SyncBootstrapQuerySchema>;

/** A published drawing the supervisor may pick: site, kind, number and its latest revision. */
export const OfflineDrawingSchema = z.object({
  drawingId: z.uuid(),
  /** null: a drawing not linked to a site yet («بدون موقع»), still published. */
  siteId: z.uuid().nullable(),
  siteName: z.string().nullable(),
  kind: z.enum(['general', 'secondary']),
  ordinal: z.number().int().min(1),
  revision: z.object({
    id: z.uuid(),
    revNo: z.number().int().min(1),
    publishedAt: z.iso.datetime({ offset: true }),
    tilesAvailable: z.boolean(),
  }),
});
export type OfflineDrawing = z.infer<typeof OfflineDrawingSchema>;

export const OfflineBundleSchema = z.object({
  serverTime: z.iso.datetime({ offset: true }),
  project: z.object({ id: z.uuid(), name: z.string(), crsEpsg: z.number().int() }),
  /** ADR-054: a supervisor's reach is his sites; project-wide roles see the whole project. */
  scope: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('project') }),
    z.object({ kind: z.literal('sites'), siteIds: z.array(z.uuid()) }),
  ]),
  /**
   * Every published drawing with its latest published revision (ADR-049 part B). ADR-054: for a
   * supervisor only the drawings of his sites (names of other sites are never sent); drawings
   * without a site are never sent to him.
   */
  drawings: z.array(OfflineDrawingSchema).default([]),
  /**
   * The picked drawing's latest published revision (`drawingId`), else the General published
   * last; null when nothing is published yet.
   */
  revision: z
    .object({
      id: z.uuid(),
      revNo: z.number().int().min(1),
      publishedAt: z.iso.datetime({ offset: true }),
      tilesAvailable: z.boolean(),
      /** The drawing of `revision` (ADR-049 part B). */
      drawingId: z.uuid().optional(),
    })
    .nullable(),
  /** Features of `revision` inside the caller's scope. */
  features: z.array(OfflineFeatureSchema),
  catalog: z.array(CatalogItemSchema),
  /**
   * ADR-056: element → main groups (system map). The device shows under an element only the groups
   * of this list that have catalog lines. Empty from an older server → the flat list as before.
   */
  elementGroups: z.array(ElementGroupsSchema).default([]),
  /**
   * Approved As-Built state of features in scope that differ from the design or were added
   * (ADR-030). The device draws these over the design and uses their versions as `baseVersion`.
   */
  asBuilt: z.array(AsBuiltFeatureStateSchema).default([]),
  settings: z.object({
    gpsWarningDistanceM: z.number().positive(),
    suggestedQuantity: CapabilityStatusSchema,
    /** Phase 2 `type_rules` per activity; until then one generic photo is required (ADR-023). */
    photoRequirements: z.object({
      status: CapabilityStatusSchema,
      byWorkType: z.record(z.string(), z.array(PhotoRequirementSchema)),
      fallback: z.array(PhotoRequirementSchema),
    }),
  }),
});
export type OfflineBundle = z.infer<typeof OfflineBundleSchema>;

// ---------------------------------------------------------------------------------------------
// Resumable photo upload

/**
 * `GET …/sync/photos/:photoId` → status. `PUT …/sync/photos/:photoId/content` with header
 * `Upload-Offset: <receivedBytes>` and a raw `application/octet-stream` chunk appends it. A wrong
 * offset answers 409 CONFLICT with this status in `details`, so the device resumes from there.
 * When the last byte arrives the server checks the sha256 and the JPEG signature; a mismatch
 * discards the received bytes and answers 422.
 */
export const PHOTO_UPLOAD_STATES = ['receiving', 'stored'] as const;
export const PhotoUploadStatusSchema = z.object({
  photoId: z.uuid(),
  sizeBytes: z.number().int().min(1),
  receivedBytes: z.number().int().min(0),
  state: z.enum(PHOTO_UPLOAD_STATES),
});
export type PhotoUploadStatus = z.infer<typeof PhotoUploadStatusSchema>;

export const UPLOAD_OFFSET_HEADER = 'upload-offset';
