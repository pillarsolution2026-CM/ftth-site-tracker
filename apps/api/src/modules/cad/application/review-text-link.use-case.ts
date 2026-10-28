import {
  EVENT_ENTITIES,
  EVENT_TYPES,
  TEXT_LINK_TARGETS,
  type ReviewTextLinkRequest,
  type TextLink,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock } from '../../../common/clock.js';
import type { CadUnitOfWork } from '../domain/cad-file.repository.js';
import { assertReviewable } from '../domain/design-revision.js';
import type { DesignReadQueries } from '../domain/design-revision.repository.js';

const invalid = (message: string, details: Record<string, unknown>) =>
  new AppError('VALIDATION_FAILED', message, details, 422);

export class ReviewTextLinkUseCase {
  constructor(
    private readonly uow: CadUnitOfWork,
    private readonly reads: DesignReadQueries,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    projectId: string;
    revisionId: string;
    linkId: string;
    actorId: string;
    review: ReviewTextLinkRequest;
  }): Promise<TextLink> {
    const { projectId, revisionId, linkId, actorId, review } = input;
    const now = this.clock.now();

    await this.uow.run(async (tx) => {
      // Publishing locks the same row, so a review and a publish never interleave.
      const revision = await tx.revisions.find(projectId, revisionId, { lock: true });
      if (!revision) throw new AppError('NOT_FOUND', 'Design revision not found');
      assertReviewable(revision);

      const link = await tx.links.find(projectId, revisionId, linkId, { lock: true });
      if (!link) throw new AppError('NOT_FOUND', 'Text link not found');

      let targetFeatureId: string | null = null;
      if (review.action === 'confirm') {
        targetFeatureId = review.featureId ?? link.featureId;
        if (!targetFeatureId) {
          throw invalid('Confirming needs a feature', { reason: 'FEATURE_REQUIRED' });
        }
        const feature = await tx.links.findFeature(projectId, revisionId, targetFeatureId);
        if (!feature) throw new AppError('NOT_FOUND', 'Feature not found in this revision');
        if (!TEXT_LINK_TARGETS[link.kind].includes(feature.featureType)) {
          throw invalid('This feature type cannot be linked to this text', {
            reason: 'FEATURE_TYPE_NOT_ALLOWED',
            kind: link.kind,
            featureType: feature.featureType,
            allowed: TEXT_LINK_TARGETS[link.kind],
          });
        }
        await tx.links.confirm(projectId, revisionId, linkId, targetFeatureId, actorId, now);
      } else {
        await tx.links.reject(projectId, revisionId, linkId, actorId, now);
      }

      // A box id link decides the box's code: recompute for the box it left and the box it joined.
      if (link.kind === 'box_id') {
        const affected = [link.featureId, targetFeatureId].filter(
          (id): id is string => id !== null,
        );
        await tx.links.recomputeBoxCodes(projectId, revisionId, [...new Set(affected)]);
      }
      await tx.links.recomputeCounts(projectId, revisionId);

      const after = review.action === 'confirm' ? 'confirmed' : 'rejected';
      await tx.events.append({
        projectId,
        entity: EVENT_ENTITIES.textLink,
        entityId: linkId,
        type: EVENT_TYPES.textLinkReviewed,
        actorId,
        payload: {
          revisionId,
          action: review.action,
          before: { status: link.status, featureId: link.featureId },
          after: {
            status: after,
            featureId: review.action === 'confirm' ? targetFeatureId : link.featureId,
          },
        },
      });
    });

    const updated = await this.reads.textLink(projectId, revisionId, linkId);
    if (!updated) throw new AppError('NOT_FOUND', 'Text link not found');
    return updated;
  }
}
