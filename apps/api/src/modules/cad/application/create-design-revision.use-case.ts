import { Logger } from '@nestjs/common';
import {
  EVENT_ENTITIES,
  EVENT_TYPES,
  type CadBuildRevisionJob,
  type CreateDesignRevisionRequest,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock, IdGenerator } from '../../../common/clock.js';
import type { CadTx, CadUnitOfWork } from '../domain/cad-file.repository.js';
import type { DesignRevision } from '../domain/design-revision.js';
import { freezeBoxTypes } from './box-types.use-cases.js';
import type { JobQueue, WorkOrderLines } from './ports.js';

const logger = new Logger('CreateDesignRevision');

const conflict = (reason: string, message: string, extra?: Record<string, unknown>) =>
  new AppError('CONFLICT', message, { reason, ...extra });

export interface NewRevisionInput {
  projectId: string;
  actorId: string;
  cadFileId: string;
  mappingVersion: number;
  revisionId: string;
  jobId: string;
  now: Date;
}

/**
 * The rules of creating a revision, inside the caller's transaction (used by create and rebuild):
 * the file and its mapping exist and match, the file is processed, no other revision of the file's kind is open, the file is the current version of its kind; the
 * mapping, the placement, the file's corrections in force, (General) its installation and (Secondary) its box types are frozen on the new revision.
 */
export async function createRevisionInTx(
  tx: CadTx,
  input: NewRevisionInput,
  workOrderLines: WorkOrderLines,
): Promise<void> {
  const { projectId, actorId, cadFileId, mappingVersion, revisionId, jobId, now } = input;
  const file = await tx.files.find(projectId, cadFileId, { lock: true });
  if (!file) throw new AppError('NOT_FOUND', 'CAD file not found');

  const mapping = await tx.mappings.find(projectId, cadFileId, { lock: true });
  if (!mapping) throw conflict('NO_MAPPING', 'The CAD file has no saved mapping');
  if (mapping.version !== mappingVersion) {
    throw conflict('MAPPING_VERSION_MISMATCH', 'The mapping changed since it was read', {
      currentVersion: mapping.version,
    });
  }
  if (file.supersededAt !== null) {
    throw conflict('NOT_CURRENT_VERSION', 'A newer version of this drawing was uploaded', {
      supersededById: file.supersededById,
    });
  }
  if (file.status !== 'processed') {
    throw conflict('NOT_PROCESSED', 'The CAD file is not processed yet', { status: file.status });
  }
  if (await tx.revisions.hasOpen(projectId, file.drawingKind)) {
    throw conflict('REVISION_IN_PROGRESS', 'The project already has an open design revision');
  }

  const baseRevisionId = await tx.revisions.findLatestPublishedId(projectId, file.drawingKind);
  // The file row is locked above, so no correction can be added or withdrawn while this reads.
  const corrections = await tx.corrections.listActiveFrozen(projectId, cadFileId);
  // Same lock: the General's installation answer and marks in force are frozen with them (ADR-042).
  const installation =
    file.drawingKind === 'general' ? await tx.installation.frozen(projectId, cadFileId) : null;
  // Same lock: the Secondary's box-type choices in force, with a snapshot of their lines (ADR-043).
  const boxTypes = await freezeBoxTypes(tx, workOrderLines, file, mapping.rules);
  await tx.revisions.insert({
    id: revisionId,
    projectId,
    cadFileId: file.id,
    drawingKind: file.drawingKind,
    currentJobId: jobId,
    baseRevisionId,
    rules: mapping.rules,
    mappingVersion: mapping.version,
    crsEpsg: mapping.crsEpsg,
    drawingUnit: mapping.drawingUnit,
    metresPerUnit: mapping.metresPerUnit,
    placement: mapping.placement,
    corrections,
    installation,
    boxTypes,
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
}

/** After the commit: a failed hand-over marks the revision failed instead of leaving it queued forever. */
export async function enqueueBuildAfterCommit(
  uow: CadUnitOfWork,
  queue: JobQueue,
  input: NewRevisionInput,
): Promise<void> {
  const { projectId, cadFileId, revisionId, jobId, actorId, now } = input;
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
    await queue.enqueueBuildRevision(job);
  } catch (error) {
    logger.error(`Could not enqueue build job ${jobId}: ${String(error)}`);
    await uow.run(async (tx) => {
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

export class CreateDesignRevisionUseCase {
  constructor(
    private readonly uow: CadUnitOfWork,
    private readonly queue: JobQueue,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly workOrderLines: WorkOrderLines,
  ) {}

  async execute(input: {
    projectId: string;
    actorId: string;
    request: CreateDesignRevisionRequest;
  }): Promise<DesignRevision> {
    const { projectId, actorId, request } = input;
    const created: NewRevisionInput = {
      projectId,
      actorId,
      cadFileId: request.cadFileId,
      mappingVersion: request.mappingVersion,
      revisionId: this.ids.next(),
      jobId: this.ids.next(),
      now: this.clock.now(),
    };

    await this.uow.run((tx) => createRevisionInTx(tx, created, this.workOrderLines));
    await enqueueBuildAfterCommit(this.uow, this.queue, created);
    const revision = await this.uow.run((tx) => tx.revisions.find(projectId, created.revisionId));
    if (!revision) throw new AppError('INTERNAL', 'The design revision disappeared');
    return revision;
  }
}
