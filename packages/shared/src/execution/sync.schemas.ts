import { z } from 'zod';
import {
  AsBuiltEditSchema,
  AsBuiltFeatureStateSchema,
  RecordAsBuiltEditOpSchema,
} from '../asbuilt/asbuilt.schemas.js';
import { DecimalStringSchema } from '../common/decimal.js';
import { FeatureTypeSchema } from '../design/feature-types.js';
import { WorkTypeSchema } from '../work-orders/work-order.schemas.js';
import { EXECUTION_LIMITS } from './execution.constants.js';
import { ExecutionUpdateSchema, RecordUpdatePayloadSchema } from './execution.schemas.js';

/**
 * Sync protocol (ADR-024). Mobile → server: `POST /projects/:projectId/sync/push` with an outbox
 * batch. Server → mobile: `GET …/sync/bootstrap` (offline bundle) and `GET …/sync/changes`
 * (updates in the caller's scope after a server cursor). Photos travel separately through the
 * resumable upload `…/sync/photos/:photoId`.
 */

export const OP_KINDS = ['execution_update.record', 'asbuilt_edit.record'] as const;
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

/** Union of every operation a device may send (Phase 4 adds As-Built edits, ADR-030). */
export const SyncOpSchema = z.discriminatedUnion('kind', [
  RecordUpdateOpSchema,
  RecordAsBuiltEditOpSchema,
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
  /** The feature is outside the caller's zones. */
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
] as const;
export const OpRejectionCodeSchema = z.enum(OP_REJECTION_CODES);
export type OpRejectionCode = z.infer<typeof OpRejectionCodeSchema>;

export const OpResultSchema = z.discriminatedUnion('outcome', [
  /**
   * `updateId` is the id of the record the op created: an execution update, or an As-Built edit
   * for `asbuilt_edit.record` (name kept from Phase 3 so devices in the field stay compatible).
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

export const OfflineBundleSchema = z.object({
  serverTime: z.iso.datetime({ offset: true }),
  project: z.object({ id: z.uuid(), name: z.string(), crsEpsg: z.number().int() }),
  scope: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('project') }),
    z.object({ kind: z.literal('zones'), zoneIds: z.array(z.uuid()) }),
  ]),
  /** Latest published revision, or null when nothing is published yet. */
  revision: z
    .object({
      id: z.uuid(),
      revNo: z.number().int().min(1),
      publishedAt: z.iso.datetime({ offset: true }),
      tilesAvailable: z.boolean(),
    })
    .nullable(),
  /** Features of `revision` inside the caller's scope. */
  features: z.array(OfflineFeatureSchema),
  catalog: z.array(CatalogItemSchema),
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
