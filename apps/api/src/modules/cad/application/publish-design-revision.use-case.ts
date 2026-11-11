import {
  EVENT_ENTITIES,
  EVENT_TYPES,
  problemTotalsOf,
  otherDrawingKind,
  type PublishBlockedDetails,
  type PublishDesignRevisionRequest,
  type PublishReadiness,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock } from '../../../common/clock.js';
import type { CadTx, CadUnitOfWork } from '../domain/cad-file.repository.js';
import { installationReportOf } from './installation.use-cases.js';
import { assertPublishable, type DesignRevision } from '../domain/design-revision.js';
import {
  pairOpenItems,
  publishBlocker,
  publishReadiness,
  type OtherDraft,
  type PublishFacts,
} from '../domain/publish-readiness.js';

/** Gathers what the publish rules need for one drawing; used by the checklist and by publishing. */
async function publishFacts(tx: CadTx, revision: DesignRevision): Promise<PublishFacts> {
  const [warnings, open, subCabinets, installation] = await Promise.all([
    tx.problems.warnings(revision.projectId, revision.id),
    tx.links.countOpenItems(revision.projectId, revision.id),
    tx.revisions.subCabinetCodes(revision.projectId, revision.id),
    installationReportOf(tx, revision),
  ]);
  const totals = problemTotalsOf(warnings);
  return {
    status: revision.status,
    drawingKind: revision.drawingKind,
    placement: revision.placement,
    problemTotal: totals.blocking,
    warningTotal: totals.warnings,
    subCabinets,
    installation,
    open,
  };
}

/** GET …/publish-readiness: the ✅ / ❌ list shown before «نشر» (ADR-038, ADR-040). */
export class GetPublishReadinessUseCase {
  constructor(private readonly uow: CadUnitOfWork) {}

  execute(projectId: string, revisionId: string): Promise<PublishReadiness> {
    return this.uow.run(async (tx) => {
      const revision = await tx.revisions.find(projectId, revisionId);
      if (!revision) throw new AppError('NOT_FOUND', 'Design revision not found');
      const otherRevision = await tx.revisions.findOpen(
        projectId,
        otherDrawingKind(revision.drawingKind),
      );
      const other: OtherDraft | null =
        otherRevision?.status === 'draft'
          ? { revisionId: otherRevision.id, facts: await publishFacts(tx, otherRevision) }
          : null;
      return publishReadiness(await publishFacts(tx, revision), other);
    });
  }
}

const BLOCKED_MESSAGE: Record<PublishBlockedDetails['reason'], string> = {
  OTHER_DRAWING_MISSING:
    'The other drawing of the work order has no built draft; both drawings are published together',
  CRS_UNKNOWN: 'The drawing coordinate system is not set; place the drawing first',
  PLACEMENT_MISSING: 'The placement has no control point in use',
  PROBLEMS_OPEN: 'The drawing still has errors; fix them before publishing',
  INSTALLATION_UNCLEAR:
    'The installation of the General is unclear; answer the question and mark the trench parts',
  CABINETS_MISMATCH:
    'The sub cabinets of the General and the Secondary do not match by name and count',
  OPEN_ITEMS: 'Open items must be acknowledged before publishing',
};

const refuse = (details: PublishBlockedDetails): AppError =>
  new AppError('CONFLICT', BLOCKED_MESSAGE[details.reason], details);

/**
 * Publishes the PAIR (ADR-040): this draft and the open draft of the other kind, together, with
 * the same revision number. Both rows are locked in id order so two publishers cannot deadlock.
 */
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
      const seen = await tx.revisions.find(projectId, revisionId);
      if (!seen) throw new AppError('NOT_FOUND', 'Design revision not found');
      assertPublishable(seen);
      const otherKind = otherDrawingKind(seen.drawingKind);
      const missing = refuse({ reason: 'OTHER_DRAWING_MISSING', drawingKind: otherKind });
      const otherSeen = await tx.revisions.findOpen(projectId, otherKind);
      if (otherSeen?.status !== 'draft') throw missing;

      // Stable lock order (by id), then re-read both under the locks.
      for (const id of [seen.id, otherSeen.id].sort()) {
        await tx.revisions.find(projectId, id, { lock: true });
      }
      const revision = await tx.revisions.find(projectId, revisionId);
      if (!revision) throw new AppError('NOT_FOUND', 'Design revision not found');
      assertPublishable(revision);
      const other = await tx.revisions.find(projectId, otherSeen.id);
      if (other?.status !== 'draft') throw missing;

      const [facts, otherFacts] = await Promise.all([
        publishFacts(tx, revision),
        publishFacts(tx, other),
      ]);
      const blocker = publishBlocker(facts, otherFacts);
      if (blocker) throw refuse(blocker);

      const open = pairOpenItems(facts, otherFacts);
      const openTotal = open.textLinksToReview + open.diffConflicts;
      if (openTotal > 0 && !request.acknowledgeOpenItems) {
        throw refuse({ reason: 'OPEN_ITEMS', ...open });
      }

      const revNo = await tx.revisions.publish(projectId, [revision.id, other.id], actorId, now);
      for (const [mine, pair, own] of [
        [revision, other, facts],
        [other, revision, otherFacts],
      ] as const) {
        await tx.events.append({
          projectId,
          entity: EVENT_ENTITIES.designRevision,
          entityId: mine.id,
          type: EVENT_TYPES.designRevisionPublished,
          actorId,
          payload: {
            revNo,
            drawingKind: mine.drawingKind,
            pairRevisionId: pair.id,
            acknowledgedOpenItems: openTotal > 0,
            textLinksToReview: own.open.textLinksToReview,
            diffConflicts: own.open.diffConflicts,
          },
        });
      }
      const published = await tx.revisions.find(projectId, revisionId);
      if (!published) throw new AppError('INTERNAL', 'The design revision disappeared');
      return published;
    });
  }
}
