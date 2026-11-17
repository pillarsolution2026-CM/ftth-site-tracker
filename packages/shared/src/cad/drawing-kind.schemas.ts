import { z } from 'zod';

/**
 * ADR-040: every work order has exactly one General (رئيسي: handholes, joints, the feeder cable to
 * every cabinet) and one Secondary (ثانوي: from each cabinet to the building boxes). A CAD file
 * gets its kind at upload; the kind never changes.
 */
export const DRAWING_KINDS = ['general', 'secondary'] as const;
export const DrawingKindSchema = z.enum(DRAWING_KINDS);
export type DrawingKind = z.infer<typeof DrawingKindSchema>;

/** The other drawing of the pair. */
export function otherDrawingKind(kind: DrawingKind): DrawingKind {
  return kind === 'general' ? 'secondary' : 'general';
}

/**
 * Query of POST /projects/:projectId/cad-files (the body is the multipart file).
 * `newVersion=true` answers «is this a new version of this work order's General / Secondary?»:
 * without it, uploading a kind that already has a current file is refused (409 `KIND_EXISTS`).
 */
export const UploadCadFileQuerySchema = z.object({
  kind: DrawingKindSchema,
  newVersion: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});
export type UploadCadFileQuery = z.infer<typeof UploadCadFileQuerySchema>;

/** 409 details of an upload refused because the kind already has a current file. */
export const KindExistsDetailsSchema = z.object({
  reason: z.literal('KIND_EXISTS'),
  kind: DrawingKindSchema,
  currentFileId: z.uuid(),
  currentFileName: z.string(),
});
export type KindExistsDetails = z.infer<typeof KindExistsDetailsSchema>;
