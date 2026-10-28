import { Logger } from '@nestjs/common';
import {
  EVENT_ENTITIES,
  EVENT_TYPES,
  type CadBuildRevisionJob,
  type CreateDesignRevisionRequest,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock, IdGenerator } from '../../../common/clock.js';
import type { CadUnitOfWork } from '../domain/cad-file.repository.js';
import type { DesignRevision } from '../domain/design-revision.js';
import type { JobQueue } from './ports.js';

const logger = new Logger('CreateDesignRevision');

const conflict = (reason: string, message: string, extra?: Record<string, unknown>) =>
  new AppError('CONFLICT', message, { reason, ...extra });

export class CreateDesignRevisionUseCase {
  constructor(
    private readonly uow: CadUnitOfWork,
    private readonly queue: JobQueue,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(input: {
    projectId: string;
    actorId: string;
    request: CreateDesignRevisionRequest;
  }): Promise<DesignRevision> {
    const { projectId, actorId, request } = input;
    const revisionId = this.ids.next();
    const jobId = this.ids.next();
    const now = this.clock.now();

    await this.uow.run(async (tx) => {
      const file = await tx.files.find(projectId, request.cadFileId, { lock: true });
      if (!file) throw new AppError('NOT_FOUND', 'CAD file not found');

      const mapping = await tx.mappings.find(projectId, request.cadFileId, { lock: true });
      if (!mapping) throw conflict('NO_MAPPING', 'The CAD file has no saved mapping');
      if (mapping.version !== request.mappingVersion) {
        throw conflict('MAPPING_VERSION_MISMATCH', 'The mapping changed since it was read', {
          currentVersion: mapping.version,
        });
      }
      if (file.status !== 'processed') {
        throw conflict('NOT_PROCESSED', 'The CAD file is not processed yet', {
          status: file.status,
        });
      }
      if (await tx.revisions.hasOpen(projectId)) {
        throw conflict('REVISION_IN_PROGRESS', 'The project already has an open design revision');
      }

      const baseRevisionId = await tx.revisions.findLatestPublishedId(projectId);
      await tx.revisions.insert({
        id: revisionId,
        projectId,
        cadFileId: file.id,
        currentJobId: jobId,
        baseRevisionId,
        rules: mapping.rules,
        mappingVersion: mapping.version,
        crsEpsg: mapping.crsEpsg,
        drawingUnit: mapping.drawingUnit,
        metresPerUnit: mapping.metresPerUnit,
        insUnits: file.insUnits,
        unitsConflict: file.crsDetection?.unitsConflict ?? false,
        createdById: actorId,
        queuedAt: now,
      });
      await tx.events.append({
        projectId,
        entity: EVENT_ENTITIES.designRevision,
        entityId: revisionId,
        type: EVENT_TYPES.designRevisionQueued,
        actorId,
        payload: {
          jobId,
          attempt: 1,
          cadFileId: file.id,
          mappingVersion: mapping.version,
          baseRevisionId,
          crsEpsg: mapping.crsEpsg,
          drawingUnit: mapping.drawingUnit,
        },
      });
    });

    await this.enqueueAfterCommit(projectId, request.cadFileId, revisionId, jobId, actorId, now);
    const created = await this.uow.run((tx) => tx.revisions.find(projectId, revisionId));
    if (!created) throw new AppError('INTERNAL', 'The design revision disappeared');
    return created;
  }

  /** After the commit: a failed hand-over marks the revision failed instead of leaving it queued forever. */
  private async enqueueAfterCommit(
    projectId: string,
    cadFileId: string,
    revisionId: string,
    jobId: string,
    actorId: string,
    now: Date,
  ): Promise<void> {
    const job: CadBuildRevisionJob = {
      id: jobId,
      type: 'cad.build_revision',
      revisionId,
      projectId,
      cadFileId,
      attempt: 1,
      enqueuedAt: now.toISOString(),
    };
    try {
      await this.queue.enqueueBuildRevision(job);
    } catch (error) {
      logger.error(`Could not enqueue build job ${jobId}: ${String(error)}`);
      await this.uow.run(async (tx) => {
        const marked = await tx.revisions.markEnqueueFailed(
          projectId,
          revisionId,
          jobId,
          'The job could not be handed to the queue',
        );
        if (!marked) return; // a newer job already superseded this one
        await tx.events.append({
          projectId,
          entity: EVENT_ENTITIES.designRevision,
          entityId: revisionId,
          type: EVENT_TYPES.designRevisionFailed,
          actorId,
          payload: { jobId, errorCode: 'ENQUEUE_FAILED' },
        });
      });
    }
  }
}
