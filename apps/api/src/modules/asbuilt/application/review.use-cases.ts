import {
  EVENT_ENTITIES,
  EVENT_TYPES,
  type AsBuiltEdit,
  type AsBuiltReviewRefusal,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock } from '../../../common/clock.js';
import { decideApproval, decideRejection } from '../domain/review.js';
import type { AsBuiltReviewUnitOfWork, AsBuiltScope } from './ports.js';

function refuse(refusal: AsBuiltReviewRefusal): never {
  if (refusal === 'SELF_REVIEW') {
    throw new AppError('FORBIDDEN', 'You cannot review an edit you recorded', {
      reason: refusal,
    });
  }
  throw new AppError(
    'CONFLICT',
    refusal === 'NOT_PENDING'
      ? 'The edit was already reviewed'
      : 'Another edit of this feature was approved since this one was drawn',
    { reason: refusal },
  );
}

interface ReviewInput {
  projectId: string;
  editId: string;
  reviewerId: string;
  scope: AsBuiltScope;
}

/** Approves one edit and moves the approved As-Built state forward (ADR-030). */
export class ApproveAsBuiltEditUseCase {
  constructor(
    private readonly uow: AsBuiltReviewUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(input: ReviewInput): Promise<AsBuiltEdit> {
    return this.uow.run(async (tx) => {
      await tx.lockProject(input.projectId);
      const edit = await tx.findEditForReview(input.projectId, input.editId, input.scope);
      if (!edit) throw new AppError('NOT_FOUND', 'As-Built edit not found');
      const current = await tx.currentVersions(input.projectId, edit.featureId);
      const decision = decideApproval({
        status: edit.status,
        kind: edit.kind,
        baseVersion: edit.baseVersion,
        editorId: edit.userId,
        reviewerId: input.reviewerId,
        current,
      });
      if (!decision.ok) refuse(decision.refusal);
      await tx.markApproved({
        projectId: input.projectId,
        editId: edit.id,
        reviewerId: input.reviewerId,
        approvedVersion: decision.approvedVersion,
        at: this.clock.now(),
      });
      await tx.applyApproval({
        projectId: input.projectId,
        editId: edit.id,
        approvedVersion: decision.approvedVersion,
      });
      await tx.appendEvent({
        projectId: input.projectId,
        entity: EVENT_ENTITIES.asBuiltEdit,
        entityId: edit.id,
        type: EVENT_TYPES.asBuiltEditApproved,
        actorId: input.reviewerId,
        payload: {
          featureId: edit.featureId,
          kind: edit.kind,
          approvedVersion: decision.approvedVersion,
          lengthM: edit.lengthM,
        },
      });
      return tx.findEdit(input.projectId, edit.id);
    });
  }
}

/** Rejects one edit with a reason. A rejected edit is final (the supervisor records a new one). */
export class RejectAsBuiltEditUseCase {
  constructor(
    private readonly uow: AsBuiltReviewUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(input: ReviewInput & { reason: string }): Promise<AsBuiltEdit> {
    return this.uow.run(async (tx) => {
      await tx.lockProject(input.projectId);
      const edit = await tx.findEditForReview(input.projectId, input.editId, input.scope);
      if (!edit) throw new AppError('NOT_FOUND', 'As-Built edit not found');
      const decision = decideRejection({
        status: edit.status,
        editorId: edit.userId,
        reviewerId: input.reviewerId,
      });
      if (!decision.ok) refuse(decision.refusal);
      await tx.markRejected({
        projectId: input.projectId,
        editId: edit.id,
        reviewerId: input.reviewerId,
        reason: input.reason,
        at: this.clock.now(),
      });
      await tx.appendEvent({
        projectId: input.projectId,
        entity: EVENT_ENTITIES.asBuiltEdit,
        entityId: edit.id,
        type: EVENT_TYPES.asBuiltEditRejected,
        actorId: input.reviewerId,
        payload: { featureId: edit.featureId, kind: edit.kind, reason: input.reason },
      });
      return tx.findEdit(input.projectId, edit.id);
    });
  }
}
