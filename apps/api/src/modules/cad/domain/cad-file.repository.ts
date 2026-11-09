import type {
  CadCurvePage,
  CadCurveListQuery,
  CadInsertListQuery,
  CadInsertPage,
  CadLayer,
  CadTextListQuery,
  CadTextPage,
} from '@ftth/shared';
import type { EventLog } from '../../../common/event-log.port.js';
import type { CadFile, DrawingViewRecord } from './cad-file.js';
import type { DrawingCorrectionRepository } from './drawing-correction.js';
import type { GpsProposalRepository } from './gps-proposal.js';
import type {
  CadMappingRepository,
  DesignRevisionRepository,
  DrawingProblemRepository,
  TextLinkRepository,
} from './design-revision.repository.js';

/** Every method filters by `projectId` (IDOR defence): another project's id is "not found". */
export interface CadFileRepository {
  list(projectId: string): Promise<CadFile[]>;
  /** `lock` takes a row lock (SELECT … FOR UPDATE) for the rest of the transaction. */
  find(projectId: string, cadFileId: string, options?: { lock?: boolean }): Promise<CadFile | null>;
  /** Inserts a row in status `uploaded` (no job yet). */
  insertUploaded(file: CadFile): Promise<void>;
  /**
   * uploaded | processed | failed | stale queued/processing → queued with a new job id; clears the
   * previous error and sets `queued_at`.
   */
  markQueued(projectId: string, cadFileId: string, jobId: string, at: Date): Promise<void>;
  /**
   * queued → failed (ENQUEUE_FAILED), only if `jobId` is still the current job.
   * Returns false when the file moved on (another job superseded this one).
   */
  markEnqueueFailed(
    projectId: string,
    cadFileId: string,
    jobId: string,
    message: string,
  ): Promise<boolean>;
  /** The drawing view state of the file (ADR-039); null when the file is not in the project. */
  findView(projectId: string, cadFileId: string): Promise<DrawingViewRecord | null>;
  /**
   * none | failed | queued-before-`staleBefore` → queued with a new view job id and `queuedAt`
   * (clears key, size, error). Returns false when the view is fresh-queued or ready.
   */
  markViewQueued(
    projectId: string,
    cadFileId: string,
    jobId: string,
    queuedAt: Date,
    staleBefore: Date,
  ): Promise<boolean>;
  /** queued → failed (QUEUE_UNAVAILABLE), only if `jobId` is still the current view job. */
  markViewEnqueueFailed(projectId: string, cadFileId: string, jobId: string): Promise<boolean>;
  /** Technical log of the last processing run (may be long); null if none. */
  findLog(projectId: string, cadFileId: string): Promise<string | null>;
}

/** Read-only queries on the extraction tables written by the CAD worker. */
export interface CadExtractionQueries {
  layers(projectId: string, cadFileId: string): Promise<CadLayer[]>;
  inserts(projectId: string, cadFileId: string, query: CadInsertListQuery): Promise<CadInsertPage>;
  texts(projectId: string, cadFileId: string, query: CadTextListQuery): Promise<CadTextPage>;
  curves(projectId: string, cadFileId: string, query: CadCurveListQuery): Promise<CadCurvePage>;
}

export interface CadTx {
  files: CadFileRepository;
  mappings: CadMappingRepository;
  revisions: DesignRevisionRepository;
  links: TextLinkRepository;
  problems: DrawingProblemRepository;
  proposals: GpsProposalRepository;
  corrections: DrawingCorrectionRepository;
  events: EventLog;
}

export interface CadUnitOfWork {
  run<T>(work: (tx: CadTx) => Promise<T>): Promise<T>;
}
