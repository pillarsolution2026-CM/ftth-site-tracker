import { z } from 'zod';
import { CrsDetectionSchema } from './crs-detection.schemas.js';

export const CAD_FORMATS = ['dwg', 'dxf'] as const;
export const CadFormatSchema = z.enum(CAD_FORMATS);
export type CadFormat = z.infer<typeof CadFormatSchema>;

/** uploaded → queued → processing → processed | failed (ADR-013). */
export const CAD_FILE_STATUSES = [
  'uploaded',
  'queued',
  'processing',
  'processed',
  'failed',
] as const;
export const CadFileStatusSchema = z.enum(CAD_FILE_STATUSES);
export type CadFileStatus = z.infer<typeof CadFileStatusSchema>;

/**
 * Allowed transitions. `processing → processing` is a crash redelivery (same job, attempt + 1).
 * `processed | failed → queued` is an explicit reprocess (new job id); `queued | processing →
 * queued` is a reprocess allowed only when stale (CAD_STALE_AFTER_MINUTES, checked by the use case).
 * Enforced by conditional UPDATEs in the API repository and the worker, keyed on `current_job_id`.
 */
export const CAD_FILE_TRANSITIONS: Readonly<Record<CadFileStatus, readonly CadFileStatus[]>> = {
  uploaded: ['queued', 'failed'],
  queued: ['processing', 'failed', 'queued'],
  processing: ['processing', 'processed', 'failed', 'queued'],
  processed: ['queued'],
  failed: ['queued'],
};

export function canTransition(from: CadFileStatus, to: CadFileStatus): boolean {
  return CAD_FILE_TRANSITIONS[from].includes(to);
}

/** A file stuck in queued/processing longer than this may be reprocessed manually. */
export const CAD_STALE_AFTER_MINUTES = 15;

export const CAD_FAILURE_CODES = [
  'ENQUEUE_FAILED',
  'FILE_MISSING',
  'CONVERTER_FAILED',
  'DXF_UNREADABLE',
  'TIMEOUT',
  'MAX_ATTEMPTS_EXCEEDED',
  'INTERNAL',
] as const;
export const CadFailureCodeSchema = z.enum(CAD_FAILURE_CODES);
export type CadFailureCode = z.infer<typeof CadFailureCodeSchema>;

export const CAD_WARNING_CODES = [
  'DWG_CONVERTED',
  'DXF_RECOVERED',
  'UNSUPPORTED_ENTITY',
  'PROXY_ENTITY',
  'XREF_NOT_RESOLVED',
  'MISSING_FONT',
  'UNREADABLE_TEXT',
  'UNITS_UNSPECIFIED',
  'EMPTY_MODELSPACE',
  'CURVE_APPROXIMATED',
  /** `$INSUNITS` declares a unit that disagrees with the CRS detected from the extents (ADR-018). */
  'UNITS_CRS_MISMATCH',
] as const;
export const CadWarningCodeSchema = z.enum(CAD_WARNING_CODES);
export type CadWarningCode = z.infer<typeof CadWarningCodeSchema>;

export const CadWarningSchema = z.object({
  code: CadWarningCodeSchema,
  /** Number of occurrences when aggregated (e.g. 12 unreadable texts). */
  count: z.number().int().min(1).default(1),
  /** Template values for the client message, e.g. { entityType: "HATCH" } or { font: "xarb.shx" }. */
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});
export type CadWarning = z.infer<typeof CadWarningSchema>;

/** Drawing extents in drawing units (SRID 0 until the CRS is confirmed in Phase 1b). */
export const CadExtentsSchema = z.object({
  minX: z.number(),
  minY: z.number(),
  maxX: z.number(),
  maxY: z.number(),
});
export type CadExtents = z.infer<typeof CadExtentsSchema>;

export const CadFileCountsSchema = z.object({
  layers: z.number().int().min(0),
  inserts: z.number().int().min(0),
  texts: z.number().int().min(0),
  curves: z.number().int().min(0),
});
export type CadFileCounts = z.infer<typeof CadFileCountsSchema>;

export const CadFileSummarySchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  originalName: z.string(),
  format: CadFormatSchema,
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  status: CadFileStatusSchema,
  uploadedById: z.uuid().nullable(),
  /** null until processed. */
  counts: CadFileCountsSchema.nullable(),
  warningCount: z.number().int().min(0),
  errorCode: CadFailureCodeSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  processedAt: z.iso.datetime().nullable(),
});
export type CadFileSummary = z.infer<typeof CadFileSummarySchema>;

export const CadFileDetailSchema = CadFileSummarySchema.extend({
  /** e.g. "AC1032". */
  dxfVersion: z.string().nullable(),
  /** "oda" | "libredwg" for DWG; "none" for DXF. */
  converter: z.enum(['oda', 'libredwg', 'none']).nullable(),
  converterVersion: z.string().nullable(),
  /** DXF $INSUNITS header value (0 = unitless). */
  insUnits: z.number().int().nullable(),
  extents: CadExtentsSchema.nullable(),
  /** CRS suggested from the extents (Phase 1b); null for files processed before 1b. */
  crsDetection: CrsDetectionSchema.nullable(),
  warnings: z.array(CadWarningSchema),
  /** Technical message for failed files (not translated; the UI shows errorCode). */
  errorMessage: z.string().nullable(),
  queuedAt: z.iso.datetime().nullable(),
  processingStartedAt: z.iso.datetime().nullable(),
});
export type CadFileDetail = z.infer<typeof CadFileDetailSchema>;

export const CadFileListResponseSchema = z.object({ items: z.array(CadFileSummarySchema) });
export type CadFileListResponse = z.infer<typeof CadFileListResponseSchema>;

/** GET …/cad-files/:cadFileId/log — converter and extraction log (plain text, may be long). */
export const CadFileLogResponseSchema = z.object({ log: z.string() });
export type CadFileLogResponse = z.infer<typeof CadFileLogResponseSchema>;
