import { EVENT_ENTITIES, EVENT_TYPES } from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock, IdGenerator } from '../../../common/clock.js';
import { assertCanReprocess, type CadFile } from '../domain/cad-file.js';
import type { CadUnitOfWork } from '../domain/cad-file.repository.js';
import { enqueueAfterCommit } from './cad-enqueue.js';
import type { JobQueue } from './ports.js';

export class ReprocessCadFileUseCase {
  constructor(
    private readonly uow: CadUnitOfWork,
    private readonly queue: JobQueue,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(input: {
    projectId: string;
    cadFileId: string;
    actorId: string;
  }): Promise<CadFile> {
    const { projectId, cadFileId, actorId } = input;
    const jobId = this.ids.next();
    const now = this.clock.now();

    const file = await this.uow.run(async (tx) => {
      const found = await tx.files.find(projectId, cadFileId, { lock: true });
      if (!found) throw new AppError('NOT_FOUND', 'CAD file not found');
      assertCanReprocess(found, now);

      await tx.files.markQueued(projectId, cadFileId, jobId, now);
      await tx.events.append({
        projectId,
        entity: EVENT_ENTITIES.cadFile,
        entityId: cadFileId,
        type: EVENT_TYPES.cadFileQueued,
        actorId,
        payload: { jobId, attempt: 1, reprocess: true, previousStatus: found.status },
      });
      return found;
    });

    await enqueueAfterCommit(this.queue, this.uow, this.clock, file, jobId, actorId);
    const current = await this.uow.run((tx) => tx.files.find(projectId, cadFileId));
    if (!current) throw new AppError('NOT_FOUND', 'CAD file not found');
    return current;
  }
}
