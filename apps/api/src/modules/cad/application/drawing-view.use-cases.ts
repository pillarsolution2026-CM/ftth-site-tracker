import type { Readable } from 'node:stream';
import { Logger } from '@nestjs/common';
import { CAD_STALE_AFTER_MINUTES, type DrawingViewState } from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock, IdGenerator } from '../../../common/clock.js';
import type { ObjectStorage } from '../../../common/object-storage.port.js';
import type { DrawingViewRecord } from '../domain/cad-file.js';
import type { CadUnitOfWork } from '../domain/cad-file.repository.js';
import type { JobQueue } from './ports.js';

const logger = new Logger('DrawingView');

export function toDrawingViewState(view: DrawingViewRecord): DrawingViewState {
  return {
    cadFileId: view.cadFileId,
    status: view.status,
    errorCode: view.status === 'failed' ? view.errorCode : null,
    sizeBytes: view.status === 'ready' ? view.sizeBytes : null,
    renderedAt: view.status === 'ready' ? (view.renderedAt?.toISOString() ?? null) : null,
  };
}

export class GetDrawingViewStateUseCase {
  constructor(private readonly uow: CadUnitOfWork) {}

  async execute(projectId: string, cadFileId: string): Promise<DrawingViewState> {
    const view = await this.uow.run((tx) => tx.files.findView(projectId, cadFileId));
    if (!view) throw new AppError('NOT_FOUND', 'CAD file not found');
    return toDrawingViewState(view);
  }
}

/**
 * Queues the render of a processed file's drawing view (ADR-039). Idempotent: a view that is
 * already queued or ready is returned unchanged; none / failed get a new job.
 */
export class RequestDrawingViewUseCase {
  constructor(
    private readonly uow: CadUnitOfWork,
    private readonly queue: JobQueue,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(projectId: string, cadFileId: string): Promise<DrawingViewState> {
    const jobId = this.ids.next();
    const now = this.clock.now();
    const staleBefore = new Date(now.getTime() - CAD_STALE_AFTER_MINUTES * 60_000);
    const queued = await this.uow.run(async (tx) => {
      const file = await tx.files.find(projectId, cadFileId, { lock: true });
      if (!file) throw new AppError('NOT_FOUND', 'CAD file not found');
      if (file.status !== 'processed') {
        throw new AppError('CONFLICT', 'The CAD file is not processed yet', {
          reason: 'NOT_PROCESSED',
          status: file.status,
        });
      }
      return tx.files.markViewQueued(projectId, cadFileId, jobId, now, staleBefore);
    });

    if (queued) {
      try {
        await this.queue.enqueueRenderView({
          id: jobId,
          type: 'cad.render_view',
          cadFileId,
          projectId,
          attempt: 1,
          enqueuedAt: this.clock.now().toISOString(),
        });
      } catch (error) {
        logger.error(`Could not enqueue view job ${jobId}: ${String(error)}`);
        await this.uow.run((tx) => tx.files.markViewEnqueueFailed(projectId, cadFileId, jobId));
      }
    }

    const view = await this.uow.run((tx) => tx.files.findView(projectId, cadFileId));
    if (!view) throw new AppError('NOT_FOUND', 'CAD file not found');
    return toDrawingViewState(view);
  }
}

/** The stored gzip JSON of a ready view; 404 otherwise. */
export class GetDrawingViewContentUseCase {
  constructor(
    private readonly uow: CadUnitOfWork,
    private readonly storage: ObjectStorage,
  ) {}

  async execute(
    projectId: string,
    cadFileId: string,
  ): Promise<{ stream: Readable; sizeBytes: number }> {
    const view = await this.uow.run((tx) => tx.files.findView(projectId, cadFileId));
    if (!view) throw new AppError('NOT_FOUND', 'CAD file not found');
    if (view.status !== 'ready' || !view.storageKey || view.sizeBytes === null) {
      throw new AppError('NOT_FOUND', 'The drawing view is not ready');
    }
    return { stream: await this.storage.get(view.storageKey), sizeBytes: view.sizeBytes };
  }
}
