import { Logger } from '@nestjs/common';
import { EVENT_ENTITIES, EVENT_TYPES, type CadImportJob } from '@ftth/shared';
import type { Clock } from '../../../common/clock.js';
import type { CadFile } from '../domain/cad-file.js';
import type { CadUnitOfWork } from '../domain/cad-file.repository.js';
import type { JobQueue } from './ports.js';

const logger = new Logger('CadEnqueue');

export function buildImportJob(file: CadFile, jobId: string, now: Date): CadImportJob {
  return {
    id: jobId,
    type: 'cad.import',
    cadFileId: file.id,
    projectId: file.projectId,
    storageKey: file.storageKey,
    format: file.format,
    attempt: 1,
    enqueuedAt: now.toISOString(),
  };
}

/**
 * Hands the job to the queue after the database commit. If that fails the file is marked
 * ENQUEUE_FAILED (so the user can reprocess) instead of staying `queued` forever.
 */
export async function enqueueAfterCommit(
  queue: JobQueue,
  uow: CadUnitOfWork,
  clock: Clock,
  file: CadFile,
  jobId: string,
  actorId: string,
): Promise<void> {
  try {
    await queue.enqueueCadImport(buildImportJob(file, jobId, clock.now()));
  } catch (error) {
    logger.error(`Could not enqueue CAD job ${jobId}: ${String(error)}`);
    await uow.run(async (tx) => {
      const marked = await tx.files.markEnqueueFailed(
        file.projectId,
        file.id,
        jobId,
        'The job could not be handed to the queue',
      );
      if (!marked) return; // a newer job already superseded this one
      await tx.events.append({
        projectId: file.projectId,
        entity: EVENT_ENTITIES.cadFile,
        entityId: file.id,
        type: EVENT_TYPES.cadFileFailed,
        actorId,
        payload: { jobId, errorCode: 'ENQUEUE_FAILED' },
      });
    });
  }
}
