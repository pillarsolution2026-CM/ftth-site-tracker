import { z } from 'zod';
import { CadFormatSchema } from './cad-file.schemas.js';

/**
 * Redis-list job protocol between the API (producer) and the Python CAD worker (ADR-013).
 * Mirrored by `workers/cad/cad_worker/adapters/job_message.py` — change both together.
 */
export const CAD_QUEUE_KEYS = {
  /** API: LPUSH. Worker: BLMOVE … RIGHT LEFT (FIFO). */
  jobs: 'cad:jobs',
  /** Per-worker in-flight list: `cad:processing:<workerId>`. Ack = LREM. */
  processingPrefix: 'cad:processing:',
  /** Worker heartbeat `cad:worker:<workerId>` (SET … EX 30, refreshed every 10 s). */
  workerHeartbeatPrefix: 'cad:worker:',
  /** Messages that failed schema validation, kept for inspection. */
  deadLetter: 'cad:dead',
  /** Results of `health` jobs only (`cad:results:<id>`, TTL 1 h). */
  resultsPrefix: 'cad:results:',
} as const;

/** Crash redeliveries per job before the file is marked failed (MAX_ATTEMPTS_EXCEEDED). */
export const CAD_JOB_MAX_ATTEMPTS = 3;
export const CAD_WORKER_HEARTBEAT_TTL_SECONDS = 30;

export const CadImportJobSchema = z.object({
  /** New UUID per enqueue; equals cad_files.current_job_id. A job whose id is no longer current is dropped. */
  id: z.uuid(),
  type: z.literal('cad.import'),
  cadFileId: z.uuid(),
  projectId: z.uuid(),
  /** Object key of the immutable original, e.g. projects/<projectId>/cad/<fileId>/original.dwg */
  storageKey: z.string().min(1).max(512),
  format: CadFormatSchema,
  /** 1 on enqueue; incremented only when a crashed worker's job is requeued. */
  attempt: z.number().int().min(1).max(CAD_JOB_MAX_ATTEMPTS),
  enqueuedAt: z.iso.datetime(),
});
export type CadImportJob = z.infer<typeof CadImportJobSchema>;

/**
 * Build a design revision from a processed CAD file (Phase 1b, ADR-017). The mapping, CRS and
 * drawing unit are read from the `design_revisions` row (frozen copy), not from the message.
 */
export const CadBuildRevisionJobSchema = z.object({
  /** Equals design_revisions.current_job_id; a job whose id is no longer current is dropped. */
  id: z.uuid(),
  type: z.literal('cad.build_revision'),
  revisionId: z.uuid(),
  projectId: z.uuid(),
  cadFileId: z.uuid(),
  attempt: z.number().int().min(1).max(CAD_JOB_MAX_ATTEMPTS),
  enqueuedAt: z.iso.datetime(),
});
export type CadBuildRevisionJob = z.infer<typeof CadBuildRevisionJobSchema>;

/**
 * Write the As-Built DXF of a project (Phase 4, ADR-030). The worker reads the latest published
 * revision named in the `asbuilt_exports` row and the approved As-Built state from the database,
 * never from the message.
 */
export const CadExportAsBuiltJobSchema = z.object({
  /** Equals asbuilt_exports.current_job_id; a job whose id is no longer current is dropped. */
  id: z.uuid(),
  type: z.literal('cad.export_asbuilt'),
  exportId: z.uuid(),
  projectId: z.uuid(),
  attempt: z.number().int().min(1).max(CAD_JOB_MAX_ATTEMPTS),
  enqueuedAt: z.iso.datetime(),
});
export type CadExportAsBuiltJob = z.infer<typeof CadExportAsBuiltJobSchema>;

/** Existing liveness probe job (Phase 0). */
export const CadHealthJobSchema = z.object({
  id: z.string().min(1),
  type: z.literal('health'),
});
export type CadHealthJob = z.infer<typeof CadHealthJobSchema>;

export const CadJobSchema = z.discriminatedUnion('type', [
  CadImportJobSchema,
  CadBuildRevisionJobSchema,
  CadExportAsBuiltJobSchema,
  CadHealthJobSchema,
]);
export type CadJob = z.infer<typeof CadJobSchema>;
