import type { CadImportJob } from '@ftth/shared';

/** Producer side of the job protocol (ADR-013). Adapter: Redis list `cad:jobs`. */
export interface JobQueue {
  /** Rejects when the job could not be handed over; the caller then marks the file ENQUEUE_FAILED. */
  enqueueCadImport(job: CadImportJob): Promise<void>;
}
