import type { CadBuildRevisionJob, CadImportJob, CadRenderViewJob } from '@ftth/shared';

/** Producer side of the job protocol (ADR-013). Adapter: Redis list `cad:jobs`. */
export interface JobQueue {
  /** Rejects when the job could not be handed over; the caller then marks the file ENQUEUE_FAILED. */
  enqueueCadImport(job: CadImportJob): Promise<void>;
  /** Same protocol for `cad.build_revision`; a rejection marks the revision ENQUEUE_FAILED. */
  enqueueBuildRevision(job: CadBuildRevisionJob): Promise<void>;
  /** Same protocol for `cad.render_view` (ADR-039); a rejection marks the view failed. */
  enqueueRenderView(job: CadRenderViewJob): Promise<void>;
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

/** One line of a project's work order as the box types need it (ADR-043). */
export interface WorkOrderLineRef {
  id: string;
  code: string;
  description: string;
}

/**
 * The project's work order lines, read through the work-orders module's exported application
 * service (ADR-043). `exists` is false when the project has no work order yet.
 */
export interface WorkOrderLines {
  findLinesOfProject(projectId: string): Promise<{ exists: boolean; lines: WorkOrderLineRef[] }>;
}
