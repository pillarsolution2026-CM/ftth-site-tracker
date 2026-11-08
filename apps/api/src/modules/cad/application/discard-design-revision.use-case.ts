import { EVENT_ENTITIES, EVENT_TYPES } from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock, IdGenerator } from '../../../common/clock.js';
import type { CadTx, CadUnitOfWork } from '../domain/cad-file.repository.js';
import { assertDiscardable, type DesignRevision } from '../domain/design-revision.js';

/** Discards a revision (already read and locked by the caller) and records the event. */
export async function discardRevisionInTx(
  tx: CadTx,
  input: { revision: DesignRevision; actorId: string; supersedingJobId: string },
): Promise<void> {
  const { revision, actorId, supersedingJobId } = input;
  await tx.revisions.discard(revision.projectId, revision.id, supersedingJobId);
  await tx.events.append({
    projectId: revision.projectId,
    entity: EVENT_ENTITIES.designRevision,
    entityId: revision.id,
    type: EVENT_TYPES.designRevisionDiscarded,
    actorId,
    payload: { previousStatus: revision.status, errorCode: revision.errorCode },
  });
}

export class DiscardDesignRevisionUseCase {
  constructor(
    private readonly uow: CadUnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(input: {
    projectId: string;
    revisionId: string;
    actorId: string;
  }): Promise<DesignRevision> {
    const { projectId, revisionId, actorId } = input;
    return this.uow.run(async (tx) => {
      const revision = await tx.revisions.find(projectId, revisionId, { lock: true });
      if (!revision) throw new AppError('NOT_FOUND', 'Design revision not found');
      assertDiscardable(revision, this.clock.now());

      await discardRevisionInTx(tx, { revision, actorId, supersedingJobId: this.ids.next() });
      const discarded = await tx.revisions.find(projectId, revisionId);
      if (!discarded) throw new AppError('INTERNAL', 'The design revision disappeared');
      return discarded;
    });
  }
}
