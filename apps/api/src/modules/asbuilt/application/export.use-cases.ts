import { Logger } from '@nestjs/common';
import { EVENT_ENTITIES, EVENT_TYPES, type AsBuiltExport } from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock, IdGenerator } from '../../../common/clock.js';
import type { ObjectStorage } from '../../../common/object-storage.port.js';
import { uniqueViolation } from '../../../db/pg-errors.js';
import type {
  AsBuiltExportQueries,
  AsBuiltExportUnitOfWork,
  AsBuiltJobQueue,
  DownloadedExport,
  ExportRecord,
} from './ports.js';

const logger = new Logger('AsBuiltExport');

/** Contract list size ("newest first, at most 50"). */
export const EXPORT_LIST_LIMIT = 50;

export function toExport(record: ExportRecord): AsBuiltExport {
  // revNo / storageKey are internal.
  return {
    id: record.id,
    revisionId: record.revisionId,
    status: record.status,
    requestedBy: record.requestedBy,
    requestedAt: record.requestedAt,
    finishedAt: record.finishedAt,
    stats: record.stats,
    sizeBytes: record.sizeBytes,
    error: record.error,
  };
}

/** ASCII-only download name: `asbuilt-r<revNo>-<first 8 of the export id>.dxf`. */
export function exportFileName(revNo: number, exportId: string): string {
  return `asbuilt-r${revNo}-${exportId
    .replace(/[^0-9a-f]/gi, '')
    .slice(0, 8)
    .toLowerCase()}.dxf`;
}

/** Queues an As-Built DXF export of the latest published revision (ADR-030, ADR-013 guard). */
export class RequestAsBuiltExportUseCase {
  constructor(
    private readonly uow: AsBuiltExportUnitOfWork,
    private readonly queue: AsBuiltJobQueue,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(input: { projectId: string; actorId: string }): Promise<AsBuiltExport> {
    const exportId = this.ids.next();
    const jobId = this.ids.next();
    const now = this.clock.now();
    try {
      await this.queueRow(input, exportId, jobId, now);
    } catch (error) {
      if (uniqueViolation(error) === 'asbuilt_exports_one_open_idx') {
        throw new AppError('CONFLICT', 'An export of this project is already running', {
          reason: 'EXPORT_IN_PROGRESS',
        });
      }
      throw error;
    }
    await this.enqueue(input, exportId, jobId, now);
    return this.exportOf(input.projectId, exportId);
  }

  private async queueRow(
    input: { projectId: string; actorId: string },
    exportId: string,
    jobId: string,
    now: Date,
  ): Promise<void> {
    await this.uow.run(async (tx) => {
      const revision = await tx.latestPublishedRevision(input.projectId);
      if (!revision) {
        throw new AppError('CONFLICT', 'No design revision is published', {
          reason: 'NO_PUBLISHED_REVISION',
        });
      }
      await tx.insert({
        id: exportId,
        projectId: input.projectId,
        revisionId: revision.id,
        jobId,
        requestedBy: input.actorId,
        at: now,
      });
      await tx.appendEvent({
        projectId: input.projectId,
        entity: EVENT_ENTITIES.asBuiltExport,
        entityId: exportId,
        type: EVENT_TYPES.asBuiltExportRequested,
        actorId: input.actorId,
        payload: { revisionId: revision.id, revNo: revision.revNo, jobId },
      });
    });
  }

  private async enqueue(
    input: { projectId: string; actorId: string },
    exportId: string,
    jobId: string,
    now: Date,
  ): Promise<void> {
    // After the commit, like the CAD import: if the queue is down the export is marked failed so
    // the user can request another one instead of waiting for a job that never runs.
    try {
      await this.queue.enqueueExport({
        id: jobId,
        exportId,
        projectId: input.projectId,
        attempt: 1,
        enqueuedAt: now.toISOString(),
      });
    } catch (error) {
      logger.error(`Could not enqueue As-Built export job ${jobId}: ${String(error)}`);
      await this.uow.run(async (tx) => {
        const marked = await tx.markEnqueueFailed(
          input.projectId,
          exportId,
          jobId,
          this.clock.now(),
        );
        if (!marked) return;
        await tx.appendEvent({
          projectId: input.projectId,
          entity: EVENT_ENTITIES.asBuiltExport,
          entityId: exportId,
          type: EVENT_TYPES.asBuiltExportFailed,
          actorId: input.actorId,
          payload: { jobId, errorCode: 'ENQUEUE_FAILED' },
        });
      });
    }
  }

  private exportOf(projectId: string, exportId: string): Promise<AsBuiltExport> {
    return this.uow.run(async (tx) => {
      const record = await tx.find(projectId, exportId);
      if (!record) throw new Error('export disappeared');
      return toExport(record);
    });
  }
}

export class ListAsBuiltExportsUseCase {
  constructor(private readonly queries: AsBuiltExportQueries) {}

  async execute(projectId: string): Promise<AsBuiltExport[]> {
    return this.queries.list(projectId, EXPORT_LIST_LIMIT);
  }
}

export class GetAsBuiltExportUseCase {
  constructor(private readonly queries: AsBuiltExportQueries) {}

  async execute(projectId: string, exportId: string): Promise<AsBuiltExport> {
    const record = await this.queries.find(projectId, exportId);
    if (!record) throw new AppError('NOT_FOUND', 'Export not found');
    return toExport(record);
  }
}

export class DownloadAsBuiltExportUseCase {
  constructor(
    private readonly queries: AsBuiltExportQueries,
    private readonly storage: ObjectStorage,
  ) {}

  async execute(projectId: string, exportId: string): Promise<DownloadedExport> {
    const record = await this.queries.find(projectId, exportId);
    if (!record) throw new AppError('NOT_FOUND', 'Export not found');
    if (record.status !== 'done' || !record.storageKey || record.sizeBytes === null) {
      throw new AppError('CONFLICT', 'The export is not ready', {
        reason: 'NOT_READY',
        status: record.status,
      });
    }
    return {
      stream: await this.storage.get(record.storageKey),
      sizeBytes: record.sizeBytes,
      fileName: exportFileName(record.revNo, record.id),
    };
  }
}
