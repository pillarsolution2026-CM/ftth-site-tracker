import type { RebuildDesignRevisionRequest } from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock, IdGenerator } from '../../../common/clock.js';
import type { CadUnitOfWork } from '../domain/cad-file.repository.js';
import type { DesignRevision } from '../domain/design-revision.js';
import {
  createRevisionInTx,
  enqueueBuildAfterCommit,
  type NewRevisionInput,
} from './create-design-revision.use-case.js';
import { discardRevisionInTx } from './discard-design-revision.use-case.js';
import type { JobQueue } from './ports.js';

/**
 * «طبّق التصليحات وابنِ من جديد» (ADR-038): discards the draft (or failed) revision and creates a
 * new one of the same file in one transaction, with the rules of the two use cases. The build job
 * is handed over after the commit, as create does.
 */
export class RebuildDesignRevisionUseCase {
  constructor(
    private readonly uow: CadUnitOfWork,
    private readonly queue: JobQueue,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(input: {
    projectId: string;
    revisionId: string;
    actorId: string;
    request: RebuildDesignRevisionRequest;
  }): Promise<DesignRevision> {
    const { projectId, revisionId, actorId, request } = input;
    const newRevisionId = this.ids.next();
    const jobId = this.ids.next();
    const now = this.clock.now();

    const created = await this.uow.run(async (tx): Promise<NewRevisionInput> => {
      const old = await tx.revisions.find(projectId, revisionId, { lock: true });
      if (!old) throw new AppError('NOT_FOUND', 'Design revision not found');
      if (old.status !== 'draft' && old.status !== 'failed') {
        throw new AppError('CONFLICT', 'Only a draft or failed revision can be rebuilt', {
          reason: 'NOT_REBUILDABLE',
          status: old.status,
        });
      }
      await discardRevisionInTx(tx, { revision: old, actorId, supersedingJobId: this.ids.next() });
      const next: NewRevisionInput = {
        projectId,
        actorId,
        cadFileId: old.cadFileId,
        mappingVersion: request.mappingVersion,
        revisionId: newRevisionId,
        jobId,
        now,
      };
      await createRevisionInTx(tx, next);
      return next;
    });

    await enqueueBuildAfterCommit(this.uow, this.queue, created);
    const revision = await this.uow.run((tx) => tx.revisions.find(projectId, newRevisionId));
    if (!revision) throw new AppError('INTERNAL', 'The design revision disappeared');
    return revision;
  }
}
