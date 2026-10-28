import {
  EVENT_ENTITIES,
  EVENT_TYPES,
  type PublishBlockedDetails,
  type PublishDesignRevisionRequest,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock } from '../../../common/clock.js';
import type { CadUnitOfWork } from '../domain/cad-file.repository.js';
import { assertPublishable, type DesignRevision } from '../domain/design-revision.js';

export class PublishDesignRevisionUseCase {
  constructor(
    private readonly uow: CadUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    projectId: string;
    revisionId: string;
    actorId: string;
    request: PublishDesignRevisionRequest;
  }): Promise<DesignRevision> {
    const { projectId, revisionId, actorId, request } = input;
    const now = this.clock.now();

    return this.uow.run(async (tx) => {
      const revision = await tx.revisions.find(projectId, revisionId, { lock: true });
      if (!revision) throw new AppError('NOT_FOUND', 'Design revision not found');
      assertPublishable(revision);

      const open = await tx.links.countOpenItems(projectId, revisionId);
      const openTotal = open.textLinksToReview + open.diffConflicts;
      if (openTotal > 0 && !request.acknowledgeOpenItems) {
        const details: PublishBlockedDetails = { reason: 'OPEN_ITEMS', ...open };
        throw new AppError(
          'CONFLICT',
          'Open items must be acknowledged before publishing',
          details,
        );
      }

      const revNo = await tx.revisions.publish(projectId, revisionId, actorId, now);
      await tx.events.append({
        projectId,
        entity: EVENT_ENTITIES.designRevision,
        entityId: revisionId,
        type: EVENT_TYPES.designRevisionPublished,
        actorId,
        payload: {
          revNo,
          acknowledgedOpenItems: openTotal > 0,
          textLinksToReview: open.textLinksToReview,
          diffConflicts: open.diffConflicts,
        },
      });
      const published = await tx.revisions.find(projectId, revisionId);
      if (!published) throw new AppError('INTERNAL', 'The design revision disappeared');
      return published;
    });
  }
}
