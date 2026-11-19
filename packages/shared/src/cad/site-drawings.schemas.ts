import { z } from 'zod';
import { DrawingKindSchema } from './drawing-kind.schemas.js';

/**
 * ADR-049 part B: drawings belong to a site of the work order. A site has ONE General and one or
 * more Secondary drawings; each drawing is a line of versions (files). Drawings uploaded before
 * this change and not linked to a site are «بدون موقع» (`siteId` null) until the PM links them.
 */

export const DRAWING_TARGETS = ['new_drawing', 'new_version'] as const;
export const DrawingTargetSchema = z.enum(DRAWING_TARGETS);
export type DrawingTarget = z.infer<typeof DrawingTargetSchema>;

/**
 * Query of POST /projects/:projectId/cad-files (the body is the multipart file). `siteId` is a
 * site of the project's work order. `new_drawing` opens a drawing of the kind (a second General in
 * one site → 409 `GENERAL_EXISTS`; a new Secondary is always allowed); `new_version` supersedes the
 * current file of `drawingId` (required, a drawing of that site and kind).
 */
export const UploadCadFileQuerySchema = z
  .object({
    siteId: z.uuid(),
    kind: DrawingKindSchema,
    target: DrawingTargetSchema,
    drawingId: z.uuid().optional(),
  })
  .refine((query) => query.target !== 'new_version' || query.drawingId !== undefined, {
    message: 'drawingId is required with target=new_version',
    path: ['drawingId'],
  })
  .refine((query) => query.target !== 'new_drawing' || query.drawingId === undefined, {
    message: 'drawingId is only for target=new_version',
    path: ['drawingId'],
  });
export type UploadCadFileQuery = z.infer<typeof UploadCadFileQuerySchema>;

/** 409 / 404 details of an upload refused for its site or drawing. */
export const UploadRefusedDetailsSchema = z.discriminatedUnion('reason', [
  /** The site already has its General; upload a new version of it instead. */
  z.object({
    reason: z.literal('GENERAL_EXISTS'),
    siteId: z.uuid(),
    drawingId: z.uuid(),
    currentFileName: z.string().nullable(),
  }),
  z.object({ reason: z.literal('SITE_NOT_FOUND'), siteId: z.uuid() }),
  z.object({ reason: z.literal('DRAWING_NOT_IN_SITE'), drawingId: z.uuid(), siteId: z.uuid() }),
  /** The drawing is not linked to a site yet (or was withdrawn): link it first. */
  z.object({ reason: z.literal('DRAWING_UNASSIGNED'), drawingId: z.uuid() }),
]);
export type UploadRefusedDetails = z.infer<typeof UploadRefusedDetailsSchema>;

export const SiteDrawingSchema = z.object({
  id: z.uuid(),
  /** null: a drawing from before sites that is not linked yet («بدون موقع»). */
  siteId: z.uuid().nullable(),
  siteName: z.string().nullable(),
  kind: DrawingKindSchema,
  /** General 1; Secondary 1, 2, … per site. */
  ordinal: z.number().int().min(1),
  currentFileId: z.uuid().nullable(),
  currentFileName: z.string().nullable(),
  /** The queued, building or draft revision of the drawing, if any. */
  openRevision: z
    .object({
      id: z.uuid(),
      status: z.enum(['queued', 'building', 'draft']),
    })
    .nullable(),
  latestPublished: z
    .object({
      id: z.uuid(),
      revNo: z.number().int().min(1),
      publishedAt: z.iso.datetime(),
    })
    .nullable(),
  /** Withdrawn drawings are not listed; the field is for the single-drawing answers. */
  withdrawnAt: z.iso.datetime().nullable(),
});
export type SiteDrawing = z.infer<typeof SiteDrawingSchema>;

/** GET /projects/:projectId/site-drawings — every site of the work order, then unassigned drawings. */
export const SiteDrawingsResponseSchema = z.object({
  sites: z.array(
    z.object({
      siteId: z.uuid(),
      name: z.string(),
      drawings: z.array(SiteDrawingSchema),
    }),
  ),
  unassigned: z.array(SiteDrawingSchema),
});
export type SiteDrawingsResponse = z.infer<typeof SiteDrawingsResponseSchema>;

/** POST …/site-drawings/:drawingId/assign-site — links an unassigned drawing, once. */
export const AssignDrawingSiteRequestSchema = z.object({ siteId: z.uuid() });
export type AssignDrawingSiteRequest = z.infer<typeof AssignDrawingSiteRequestSchema>;
