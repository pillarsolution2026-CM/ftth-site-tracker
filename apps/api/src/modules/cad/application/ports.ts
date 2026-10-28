import type { CadBuildRevisionJob, CadImportJob } from '@ftth/shared';

/** Producer side of the job protocol (ADR-013). Adapter: Redis list `cad:jobs`. */
export interface JobQueue {
  /** Rejects when the job could not be handed over; the caller then marks the file ENQUEUE_FAILED. */
  enqueueCadImport(job: CadImportJob): Promise<void>;
  /** Same protocol for `cad.build_revision`; a rejection marks the revision ENQUEUE_FAILED. */
  enqueueBuildRevision(job: CadBuildRevisionJob): Promise<void>;
}

/** The project's CRS, read through the projects module's application service. */
export interface ProjectEpsgLookup {
  epsgOf(projectId: string): Promise<number>;
}

/** Signed tile URLs (ADR-021); `null` in the use cases means the feature is not configured. */
export interface TileConfig {
  secret: string;
  /** Base URL of Martin behind Caddy, without a trailing slash. */
  publicUrl: string;
}
