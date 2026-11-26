import { z } from 'zod';
import { DrawingKindSchema } from '../cad/drawing-kind.schemas.js';
import { DecimalStringSchema } from '../common/decimal.js';
import { FeatureTypeSchema } from '../design/feature-types.js';
import { WorkTypeSchema } from '../work-orders/work-order.schemas.js';
import { LineDimensionsSchema } from './element-groups.js';
import { UpdateFlagSchema, UpdateLineRoleSchema, UpdateStatusSchema } from './execution.schemas.js';

/**
 * Read-only web list of the execution updates recorded on the phones (ADR-059). Every name the
 * page shows (site, drawing, element code, line, contractor, supervisor) is resolved by the
 * server; nothing here changes an update.
 */

/** technical: rows of one page of the web list. */
export const UPDATE_LIST_MAX_PAGE = 100;

export const UpdateListQuerySchema = z.object({
  status: UpdateStatusSchema.optional(),
  siteId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(UPDATE_LIST_MAX_PAGE).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
export type UpdateListQuery = z.infer<typeof UpdateListQuerySchema>;

/** Who did a work line: a contractor (by name and scope) or the company itself; null on materials. */
export const UpdateListPerformerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('contractor'),
    contractorName: z.string(),
    scope: z.string().nullable(),
  }),
  z.object({ kind: z.literal('self') }),
]);
export type UpdateListPerformer = z.infer<typeof UpdateListPerformerSchema>;

export const UpdateListLineSchema = z.object({
  role: UpdateLineRoleSchema,
  workOrderNumber: z.string(),
  itemCode: z.string(),
  itemDescription: z.string(),
  unit: z.string(),
  quantity: DecimalStringSchema,
  dimensions: LineDimensionsSchema.nullable(),
  performer: UpdateListPerformerSchema.nullable(),
});
export type UpdateListLine = z.infer<typeof UpdateListLineSchema>;

export const UpdateListPhotoSchema = z.object({
  photoId: z.uuid(),
  requirementKey: z.string(),
  /** false while the phone is still sending it (no image to show yet). */
  stored: z.boolean(),
});
export type UpdateListPhoto = z.infer<typeof UpdateListPhotoSchema>;

/** The raw GPS fix of the update (WGS84, display only) and its accuracy. */
export const UpdateListGpsSchema = z.object({
  lat: z.number(),
  lon: z.number(),
  accuracyM: z.number().nullable(),
});
export type UpdateListGps = z.infer<typeof UpdateListGpsSchema>;

export const UpdateListItemSchema = z.object({
  id: z.uuid(),
  status: UpdateStatusSchema,
  workType: WorkTypeSchema,
  /** Null on a «التخطيط» update recorded on the drawing (ADR-056). */
  featureId: z.uuid().nullable(),
  featureType: FeatureTypeSchema.nullable(),
  /** The element's code or name in the drawing (a cabinet's name); null when it has none. */
  featureCode: z.string().nullable(),
  siteId: z.uuid().nullable(),
  siteName: z.string().nullable(),
  drawingKind: DrawingKindSchema,
  drawingOrdinal: z.number().int(),
  revNo: z.number().int(),
  supervisorName: z.string(),
  /** ADR-057 (Africa/Cairo day); null only on updates stored before it. */
  workDate: z.iso.date().nullable(),
  capturedAt: z.iso.datetime({ offset: true }),
  receivedAt: z.iso.datetime({ offset: true }),
  gps: UpdateListGpsSchema.nullable(),
  gpsDistanceM: DecimalStringSchema.nullable(),
  flags: z.array(UpdateFlagSchema),
  label: z.string().nullable(),
  note: z.string().nullable(),
  reviewReason: z.string().nullable(),
  lines: z.array(UpdateListLineSchema),
  photos: z.array(UpdateListPhotoSchema),
});
export type UpdateListItem = z.infer<typeof UpdateListItemSchema>;

export const UpdateListSiteSchema = z.object({ id: z.uuid(), name: z.string() });

export const UpdateListResponseSchema = z.object({
  items: z.array(UpdateListItemSchema),
  total: z.number().int().min(0),
  /** Sites that have updates in the caller's reach (for the site filter). */
  sites: z.array(UpdateListSiteSchema),
});
export type UpdateListResponse = z.infer<typeof UpdateListResponseSchema>;
