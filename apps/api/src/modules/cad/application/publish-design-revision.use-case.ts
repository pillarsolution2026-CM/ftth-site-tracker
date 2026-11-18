import {
  EVENT_ENTITIES,
  EVENT_TYPES,
  problemTotalsOf,
  type DrawingFlow,
  type PublishBlockedDetails,
  type PublishDesignRevisionRequest,
  type PublishReadiness,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock } from '../../../common/clock.js';
import type { CadTx, CadUnitOfWork } from '../domain/cad-file.repository.js';
import { assertPublishable, type DesignRevision } from '../domain/design-revision.js';
import {
  draftsOf,
  siteBlocker,
  siteOpenItems,
  siteReadiness,
  type PublishFacts,
  type SiteDrawingFacts,
  type SiteFacts,
} from '../domain/publish-readiness.js';
import { isActive, sortDrawings, type SiteDrawingRecord } from '../domain/site-drawing.js';
import { boxTypesReportOf } from './box-types.use-cases.js';
import { installationReportOf } from './installation.use-cases.js';
import type { WorkOrderLines, WorkOrderSites } from './ports.js';

/** What the site rules need to read: the work order's lines (box types) and sites (cabinets elsewhere). */
export interface PublishDeps {
  workOrderLines: WorkOrderLines;
  sites: WorkOrderSites;
  flow: DrawingFlow;
}

/** Gathers what the publish rules need for one draft; used by the checklist and by publishing. */
async function publishFacts(
  tx: CadTx,
  deps: PublishDeps,
  revision: DesignRevision,
): Promise<PublishFacts> {
  const [warnings, open, installation, boxTypes] = await Promise.all([
    tx.problems.warnings(revision.projectId, revision.id),
    tx.links.countOpenItems(revision.projectId, revision.id),
    installationReportOf(tx, revision, deps.flow),
    boxTypesReportOf(tx, deps.workOrderLines, revision, deps.flow),
  ]);
  const totals = problemTotalsOf(warnings);
  return {
    status: revision.status,
    drawingKind: revision.drawingKind,
    drawingId: revision.drawingId,
    ordinal: revision.drawingOrdinal,
    placement: revision.placement,
    problemTotal: totals.blocking,
    warningTotal: totals.warnings,
    installation,
    boxTypes,
    open,
  };
}

async function drawingFacts(
  tx: CadTx,
  deps: PublishDeps,
  drawing: SiteDrawingRecord,
): Promise<SiteDrawingFacts> {
  const projectId = drawing.projectId;
  const base = { drawingId: drawing.id, kind: drawing.kind, ordinal: drawing.ordinal };
  const open = await tx.revisions.findOpen(projectId, drawing.id);
  if (open?.status === 'draft') {
    return {
      ...base,
      draft: { revisionId: open.id, facts: await publishFacts(tx, deps, open) },
      hasPublished: false,
      notReady: null,
      subCabinets: await tx.revisions.subCabinetCodes(projectId, open.id),
    };
  }
  if (open) {
    return {
      ...base,
      draft: null,
      hasPublished: false,
      notReady: open.status === 'queued' ? 'queued' : 'building',
      subCabinets: null,
    };
  }
  const published = await tx.revisions.findLatestPublished(projectId, drawing.id);
  if (published) {
    return {
      ...base,
      draft: null,
      hasPublished: true,
      notReady: null,
      subCabinets: await tx.revisions.subCabinetCodes(projectId, published.id),
    };
  }
  return { ...base, draft: null, hasPublished: false, notReady: 'no_revision', subCabinets: null };
}

/** The facts of every non-withdrawn drawing of the site and the Generals of the other sites. */
async function loadSiteFacts(
  tx: CadTx,
  deps: PublishDeps,
  projectId: string,
  siteId: string,
  drawings: SiteDrawingRecord[],
): Promise<SiteFacts> {
  const facts: SiteDrawingFacts[] = [];
  for (const drawing of sortDrawings(drawings.filter(isActive))) {
    facts.push(await drawingFacts(tx, deps, drawing));
  }
  const all = await deps.sites.listOfProject(projectId);
  const others = all.filter((site) => site.id !== siteId);
  const cabinets = await tx.revisions.siteGeneralCabinets(
    projectId,
    others.map((site) => site.id),
  );
  return {
    siteId,
    drawings: facts,
    otherSites: cabinets.flatMap((entry) => {
      const site = others.find((s) => s.id === entry.siteId);
      return site ? [{ siteId: site.id, siteName: site.name, names: entry.names }] : [];
    }),
  };
}

const unassignedRefusal = (revision: DesignRevision): AppError =>
  refuse({
    reason: 'SITE_UNASSIGNED',
    drawingKind: revision.drawingKind,
    drawingId: revision.drawingId,
    ordinal: revision.drawingOrdinal,
  });

/** GET …/publish-readiness of a revision: the checklist of its site (ADR-038, ADR-049 part B). */
export class GetPublishReadinessUseCase {
  constructor(
    private readonly uow: CadUnitOfWork,
    private readonly workOrderLines: WorkOrderLines,
    private readonly sites: WorkOrderSites,
    private readonly flow: DrawingFlow,
  ) {}

  execute(projectId: string, revisionId: string): Promise<PublishReadiness> {
    return this.uow.run(async (tx) => {
      const revision = await tx.revisions.find(projectId, revisionId);
      if (!revision) throw new AppError('NOT_FOUND', 'Design revision not found');
      const deps: PublishDeps = {
        workOrderLines: this.workOrderLines,
        sites: this.sites,
        flow: this.flow,
      };
      const requested = { revisionId: revision.id, drawingKind: revision.drawingKind };
      if (revision.siteId === null) {
        // «بدون موقع»: nothing can be published until the drawing is linked to a site.
        const unassigned: SiteFacts = {
          siteId: '',
          drawings: [
            {
              drawingId: revision.drawingId,
              kind: revision.drawingKind,
              ordinal: revision.drawingOrdinal,
              draft:
                revision.status === 'draft'
                  ? { revisionId: revision.id, facts: await publishFacts(tx, deps, revision) }
                  : null,
              hasPublished: false,
              notReady: 'no_revision',
              subCabinets: null,
            },
          ],
          otherSites: [],
        };
        return { ...siteReadiness(unassigned, this.flow, requested), siteId: null, canPublish: false };
      }
      const drawings = await tx.drawings.listOfSite(projectId, revision.siteId);
      const facts = await loadSiteFacts(tx, deps, projectId, revision.siteId, drawings);
      return siteReadiness(facts, this.flow, requested);
    });
  }
}

/** GET …/sites/:siteId/publish-readiness: the checklist of a site, whatever draft is asked from. */
export class GetSitePublishReadinessUseCase {
  constructor(
    private readonly uow: CadUnitOfWork,
    private readonly workOrderLines: WorkOrderLines,
    private readonly sites: WorkOrderSites,
    private readonly flow: DrawingFlow,
  ) {}

  execute(projectId: string, siteId: string): Promise<PublishReadiness> {
    return this.uow.run(async (tx) => {
      const known = (await this.sites.listOfProject(projectId)).some((site) => site.id === siteId);
      if (!known) throw new AppError('NOT_FOUND', 'Site not found');
      const deps: PublishDeps = {
        workOrderLines: this.workOrderLines,
        sites: this.sites,
        flow: this.flow,
      };
      const drawings = await tx.drawings.listOfSite(projectId, siteId);
      return siteReadiness(await loadSiteFacts(tx, deps, projectId, siteId, drawings), this.flow, null);
    });
  }
}

const BLOCKED_MESSAGE: Record<PublishBlockedDetails['reason'], string> = {
  SITE_UNASSIGNED: 'The drawing is not linked to a site; link it to a site before publishing',
  SITE_INCOMPLETE: 'The site needs its General and at least one Secondary drawing',
  DRAWING_NOT_READY: 'A drawing of the site has no built draft or published revision yet',
  CRS_UNKNOWN: 'The drawing coordinate system is not set; place the drawing first',
  PLACEMENT_MISSING: 'The placement has no control point in use',
  PROBLEMS_OPEN: 'The drawing still has errors; fix them before publishing',
  INSTALLATION_UNCLEAR:
    'The installation of the General is unclear; answer the question and mark the trench parts',
  BOX_TYPES_UNCLEAR:
    'The box types of the Secondary are unclear; choose a work-order line for every box shape',
  CABINETS_MISMATCH:
    'The sub cabinets of the General are not the sub cabinets of the Secondaries of the site',
  CABINET_IN_OTHER_SITE: 'A cabinet name of this site is already used in another site',
  OPEN_ITEMS: 'Open items must be acknowledged before publishing',
};

const refuse = (details: PublishBlockedDetails): AppError =>
  new AppError('CONFLICT', BLOCKED_MESSAGE[details.reason], details);

/**
 * Publishes the SITE (ADR-049 part B): every draft of the revision's site, together, with one
 * revision number. The site's drawing rows are locked in id order, then its drafts, so two
 * publishers of one site queue and cannot deadlock.
 */
export class PublishDesignRevisionUseCase {
  constructor(
    private readonly uow: CadUnitOfWork,
    private readonly clock: Clock,
    private readonly workOrderLines: WorkOrderLines,
    private readonly sites: WorkOrderSites,
    private readonly flow: DrawingFlow,
  ) {}

  async execute(input: {
    projectId: string;
    revisionId: string;
    actorId: string;
    request: PublishDesignRevisionRequest;
  }): Promise<DesignRevision> {
    const { projectId, revisionId, actorId, request } = input;
    const now = this.clock.now();
    const deps: PublishDeps = {
      workOrderLines: this.workOrderLines,
      sites: this.sites,
      flow: this.flow,
    };

    return this.uow.run(async (tx) => {
      const seen = await tx.revisions.find(projectId, revisionId);
      if (!seen) throw new AppError('NOT_FOUND', 'Design revision not found');
      assertPublishable(seen);
      if (seen.siteId === null) throw unassignedRefusal(seen);
      const siteId = seen.siteId;

      // Locks: the site's drawing rows (id order), then the open revisions of its drawings (id order).
      const drawings = await tx.drawings.listOfSite(projectId, siteId, { lock: true });
      const openIds: string[] = [];
      for (const drawing of drawings.filter(isActive)) {
        const open = await tx.revisions.findOpen(projectId, drawing.id);
        if (open) openIds.push(open.id);
      }
      for (const id of [...new Set([...openIds, seen.id])].sort()) {
        await tx.revisions.find(projectId, id, { lock: true });
      }
      const revision = await tx.revisions.find(projectId, revisionId);
      if (!revision) throw new AppError('NOT_FOUND', 'Design revision not found');
      assertPublishable(revision);

      const site = await loadSiteFacts(tx, deps, projectId, siteId, drawings);
      const blocker = siteBlocker(site);
      if (blocker) throw refuse(blocker);

      const open = siteOpenItems(site);
      const openTotal = open.textLinksToReview + open.diffConflicts;
      if (openTotal > 0 && !request.acknowledgeOpenItems) {
        throw refuse({ reason: 'OPEN_ITEMS', ...open });
      }

      const drafts = draftsOf(site);
      const siteRevisionIds = drafts.map((d) => d.revisionId);
      if (!siteRevisionIds.includes(revision.id)) {
        throw new AppError('CONFLICT', 'The revision is no longer a draft of its site', {
          reason: 'NOT_DRAFT',
          status: revision.status,
        });
      }
      const revNo = await tx.revisions.publish(projectId, siteId, siteRevisionIds, actorId, now);
      for (const draft of drafts) {
        await tx.events.append({
          projectId,
          entity: EVENT_ENTITIES.designRevision,
          entityId: draft.revisionId,
          type: EVENT_TYPES.designRevisionPublished,
          actorId,
          payload: {
            revNo,
            drawingId: draft.drawing.drawingId,
            siteId,
            siteRevisionIds,
            drawingKind: draft.drawing.kind,
            acknowledgedOpenItems: openTotal > 0,
            textLinksToReview: draft.facts.open.textLinksToReview,
            diffConflicts: draft.facts.open.diffConflicts,
          },
        });
      }
      const published = await tx.revisions.find(projectId, revisionId);
      if (!published) throw new AppError('INTERNAL', 'The design revision disappeared');
      return published;
    });
  }
}
