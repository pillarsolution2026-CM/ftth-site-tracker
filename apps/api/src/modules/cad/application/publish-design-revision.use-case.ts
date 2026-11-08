import {
  EVENT_ENTITIES,
  EVENT_TYPES,
  drawingProblemsOf,
  type PublishBlockedDetails,
  type PublishDesignRevisionRequest,
  type PublishReadiness,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock } from '../../../common/clock.js';
import type { CadTx, CadUnitOfWork } from '../domain/cad-file.repository.js';
import { assertPublishable, type DesignRevision } from '../domain/design-revision.js';
import {
  publishBlocker,
  publishReadiness,
  type PublishFacts,
} from '../domain/publish-readiness.js';
import { problemTotal } from './drawing-problems.use-cases.js';

/** Gathers what the publish rules need; used by the checklist and by publishing alike. */
async function publishFacts(tx: CadTx, revision: DesignRevision): Promise<PublishFacts> {
  const [warnings, open] = await Promise.all([
    tx.problems.warnings(revision.projectId, revision.id),
    tx.links.countOpenItems(revision.projectId, revision.id),
  ]);
  return {
    status: revision.status,
    placement: revision.placement,
    problemTotal: problemTotal(drawingProblemsOf(warnings)),
    open,
  };
}

/** GET …/publish-readiness: the ✅ / ❌ list shown before «نشر» (ADR-038). */
export class GetPublishReadinessUseCase {
  constructor(private readonly uow: CadUnitOfWork) {}

  execute(projectId: string, revisionId: string): Promise<PublishReadiness> {
    return this.uow.run(async (tx) => {
      const revision = await tx.revisions.find(projectId, revisionId);
      if (!revision) throw new AppError('NOT_FOUND', 'Design revision not found');
      return publishReadiness(await publishFacts(tx, revision));
    });
  }
}

const BLOCKED_MESSAGE: Record<PublishBlockedDetails['reason'], string> = {
  CRS_UNKNOWN: 'The drawing coordinate system is not set; place the drawing first',
  PLACEMENT_MISSING: 'The placement has no control point in use',
  PROBLEMS_OPEN: 'The drawing still has errors; fix them before publishing',
  OPEN_ITEMS: 'Open items must be acknowledged before publishing',
};

const refuse = (details: PublishBlockedDetails): AppError =>
  new AppError('CONFLICT', BLOCKED_MESSAGE[details.reason], details);

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

      const facts = await publishFacts(tx, revision);
      const blocker = publishBlocker(facts);
      if (blocker) throw refuse(blocker);

      const { open } = facts;
      const openTotal = open.textLinksToReview + open.diffConflicts;
      if (openTotal > 0 && !request.acknowledgeOpenItems) {
        throw refuse({ reason: 'OPEN_ITEMS', ...open });
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
