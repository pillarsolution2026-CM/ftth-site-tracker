import { z } from 'zod';
import { Decimal4StringSchema, DecimalStringSchema } from '../common/decimal.js';
import { FeatureTypeSchema } from '../design/feature-types.js';
import { WorkTypeSchema } from '../work-orders/work-order.schemas.js';
import { EXECUTION_LIMITS } from './execution.constants.js';

/**
 * Execution updates recorded by supervisors on the mobile app (Phase 3, ADR-024).
 *
 * Every write travels as an operation with a client-generated `clientOpId` (UUID). The server
 * stores the first copy and answers every resend of the same id with the stored result, so a
 * device may retry forever without creating duplicates. Updates are immutable once recorded.
 */

/** Quantities are exact decimal strings (never floats) and strictly positive. */
const PositiveQuantitySchema = Decimal4StringSchema.refine(
  (value) => !/^0(\.0+)?$/.test(value),
  'Quantity must be greater than zero',
);

/** Step 2 (work items) or step 3 (materials) of the update tool. */
export const UPDATE_LINE_ROLES = ['work', 'material'] as const;
export const UpdateLineRoleSchema = z.enum(UPDATE_LINE_ROLES);
export type UpdateLineRole = z.infer<typeof UpdateLineRoleSchema>;

export const UpdateLineInputSchema = z.object({
  workOrderItemId: z.uuid(),
  quantity: PositiveQuantitySchema,
  role: UpdateLineRoleSchema,
});
export type UpdateLineInput = z.infer<typeof UpdateLineInputSchema>;

/** WGS 84 fix as reported by the device; the server converts it to the project CRS. */
export const GpsFixSchema = z.object({
  lon: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
  accuracyM: z.number().min(0).max(100_000).nullable(),
  /** Device clock at the fix. */
  at: z.iso.datetime({ offset: true }),
});
export type GpsFix = z.infer<typeof GpsFixSchema>;

export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
export const PHOTO_CONTENT_TYPES = ['image/jpeg'] as const;

/** Requirement keys are opaque until Phase 2 `type_rules` define them; `general` is any photo. */
export const PhotoRequirementKeySchema = z
  .string()
  .regex(/^[a-z0-9_]{1,64}$/, 'Expected a lower-case key');

export const PhotoMetaSchema = z.object({
  /** Client-generated id; also the resumable-upload id. */
  photoId: z.uuid(),
  requirementKey: PhotoRequirementKeySchema,
  sha256: z.string().regex(SHA256_HEX_PATTERN, 'Expected a lower-case sha256 hex digest'),
  sizeBytes: z.number().int().min(1).max(EXECUTION_LIMITS.maxPhotoBytes),
  contentType: z.enum(PHOTO_CONTENT_TYPES),
  takenAt: z.iso.datetime({ offset: true }),
  gps: GpsFixSchema.nullable(),
});
export type PhotoMeta = z.infer<typeof PhotoMetaSchema>;

/** Warnings the device showed and the supervisor accepted before saving. */
export const CLIENT_WARNINGS = ['GPS_FAR', 'GPS_UNAVAILABLE', 'ITEM_OVERRUN'] as const;
export const ClientWarningSchema = z.enum(CLIENT_WARNINGS);
export type ClientWarning = z.infer<typeof ClientWarningSchema>;

export const RecordUpdatePayloadSchema = z
  .object({
    featureId: z.uuid(),
    /** The published revision the supervisor was looking at. */
    designRevisionId: z.uuid(),
    /** Step 1, activity: the work type of ADR-016 until Phase 2 adds activity categories. */
    workType: WorkTypeSchema,
    lines: z.array(UpdateLineInputSchema).min(1).max(EXECUTION_LIMITS.maxLinesPerUpdate),
    label: z.string().trim().min(1).max(EXECUTION_LIMITS.labelMaxLength).nullable(),
    note: z.string().trim().min(1).max(EXECUTION_LIMITS.noteMaxLength).nullable(),
    gps: GpsFixSchema.nullable(),
    photos: z.array(PhotoMetaSchema).min(1).max(EXECUTION_LIMITS.maxPhotosPerUpdate),
    acknowledgedWarnings: z.array(ClientWarningSchema).max(CLIENT_WARNINGS.length),
  })
  .superRefine((payload, ctx) => {
    const photoIds = new Set(payload.photos.map((photo) => photo.photoId));
    if (photoIds.size !== payload.photos.length) {
      ctx.addIssue({ code: 'custom', path: ['photos'], message: 'Duplicate photoId' });
    }
    const lineKeys = new Set(payload.lines.map((line) => `${line.role}:${line.workOrderItemId}`));
    if (lineKeys.size !== payload.lines.length) {
      ctx.addIssue({ code: 'custom', path: ['lines'], message: 'Duplicate item in the same step' });
    }
  });
export type RecordUpdatePayload = z.infer<typeof RecordUpdatePayloadSchema>;

export const UPDATE_STATUSES = ['pending', 'approved', 'rejected'] as const;
export const UpdateStatusSchema = z.enum(UPDATE_STATUSES);
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;

/**
 * Server-computed flags for QC (never a rejection, ADR-024):
 * - CLOCK_AHEAD: capturedAt is later than the server's receipt time plus the skew tolerance.
 * - CLOCK_BEHIND: capturedAt is earlier than the publication of the revision the device used.
 * - GPS_FAR / GPS_MISSING: the fix is farther than the warning distance from the feature, or absent.
 * - ITEM_OVERRUN: recorded quantity (all non-rejected updates) now exceeds the work-order quantity.
 * - REVISION_OUTDATED: a newer revision was published before the update was received.
 * - FEATURE_REMOVED: the feature is not in the latest published revision.
 */
export const UPDATE_FLAGS = [
  'CLOCK_AHEAD',
  'CLOCK_BEHIND',
  'GPS_FAR',
  'GPS_MISSING',
  'ITEM_OVERRUN',
  'REVISION_OUTDATED',
  'FEATURE_REMOVED',
] as const;
export const UpdateFlagSchema = z.enum(UPDATE_FLAGS);
export type UpdateFlag = z.infer<typeof UpdateFlagSchema>;

export const UpdateLineSchema = z.object({
  workOrderItemId: z.uuid(),
  quantity: DecimalStringSchema,
  role: UpdateLineRoleSchema,
});

export const UpdatePhotoStateSchema = z.object({
  photoId: z.uuid(),
  requirementKey: z.string(),
  sizeBytes: z.number().int(),
  /** true once the full file arrived and its sha256 matched. */
  stored: z.boolean(),
});

export const ExecutionUpdateSchema = z.object({
  id: z.uuid(),
  clientOpId: z.uuid(),
  featureId: z.uuid(),
  featureType: FeatureTypeSchema,
  designRevisionId: z.uuid(),
  userId: z.uuid(),
  deviceId: z.uuid(),
  workType: WorkTypeSchema,
  status: UpdateStatusSchema,
  lines: z.array(UpdateLineSchema),
  label: z.string().nullable(),
  note: z.string().nullable(),
  /** Device clock (may be wrong; see flags). */
  capturedAt: z.iso.datetime({ offset: true }),
  /** Server clock; the only time used for ordering. */
  receivedAt: z.iso.datetime({ offset: true }),
  gpsDistanceM: DecimalStringSchema.nullable(),
  flags: z.array(UpdateFlagSchema),
  reviewReason: z.string().nullable(),
  photos: z.array(UpdatePhotoStateSchema),
});
export type ExecutionUpdate = z.infer<typeof ExecutionUpdateSchema>;
