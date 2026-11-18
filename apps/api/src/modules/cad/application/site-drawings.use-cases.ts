import {
  EVENT_ENTITIES,
  EVENT_TYPES,
  type AssignDrawingSiteRequest,
  type SiteDrawing,
  type SiteDrawingsResponse,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock, IdGenerator } from '../../../common/clock.js';
import type { CadUnitOfWork } from '../domain/cad-file.repository.js';
import {
  isActive,
  nextOrdinal,
  sortDrawings,
  type SiteDrawingRecord,
  type SiteDrawingState,
} from '../domain/site-drawing.js';
import { discardRevisionInTx } from './discard-design-revision.use-case.js';
import type { WorkOrderSites } from './ports.js';

export function toSiteDrawingDto(drawing: SiteDrawingState, siteName: string | null): SiteDrawing {
  return {
    id: drawing.id,
    siteId: drawing.siteId,
    siteName,
    kind: drawing.kind,
    ordinal: drawing.ordinal,
    currentFileId: drawing.currentFile?.id ?? null,
    currentFileName: drawing.currentFile?.originalName ?? null,
    openRevision: drawing.openRevision,
    latestPublished: drawing.latestPublished
      ? {
          id: drawing.latestPublished.id,
          revNo: drawing.latestPublished.revNo,
          publishedAt: drawing.latestPublished.publishedAt.toISOString(),
        }
      : null,
    withdrawnAt: drawing.withdrawnAt?.toISOString() ?? null,
  };
}

/** GET …/site-drawings: every site of the work order with its drawings, then the unassigned ones. */
export class ListSiteDrawingsUseCase {
  constructor(
    private readonly uow: CadUnitOfWork,
    private readonly sites: WorkOrderSites,
  ) {}

  async execute(projectId: string): Promise<SiteDrawingsResponse> {
    const sites = await this.sites.listOfProject(projectId);
    const drawings = await this.uow.run((tx) => tx.drawings.listWithState(projectId));
    const names = new Map(sites.map((site) => [site.id, site.name]));
    return {
      sites: sites.map((site) => ({
        siteId: site.id,
        name: site.name,
        drawings: sortDrawings(drawings.filter((d) => d.siteId === site.id)).map((d) =>
          toSiteDrawingDto(d, site.name),
        ),
      })),
      unassigned: sortDrawings(
        drawings.filter((d) => d.siteId === null || !names.has(d.siteId)),
      ).map((d) => toSiteDrawingDto(d, null)),
    };
  }
}

/** «اربط بموقع»: links a drawing from before sites to a site of the work order, once. */
export class AssignDrawingSiteUseCase {
  constructor(
    private readonly uow: CadUnitOfWork,
    private readonly sites: WorkOrderSites,
  ) {}

  async execute(input: {
    projectId: string;
    drawingId: string;
    actorId: string;
    request: AssignDrawingSiteRequest;
  }): Promise<void> {
    const { projectId, drawingId, actorId, request } = input;
    const site = (await this.sites.listOfProject(projectId)).find((s) => s.id === request.siteId);
    if (!site) {
      throw new AppError('NOT_FOUND', 'The site is not on the work order of this project', {
        reason: 'SITE_NOT_FOUND',
        siteId: request.siteId,
      });
    }
    await this.uow.run(async (tx) => {
      // Serialise with uploads and other assignments of the project (one General per site).
      await tx.drawings.lockProject(projectId);
      const drawing = await tx.drawings.find(projectId, drawingId, { lock: true });
      if (!drawing) throw new AppError('NOT_FOUND', 'Drawing not found');
      if (drawing.siteId !== null || !isActive(drawing)) {
        throw new AppError('CONFLICT', 'The drawing is already linked to a site', {
          reason: 'ALREADY_ASSIGNED',
        });
      }
      const inSite = await tx.drawings.listOfSite(projectId, site.id, { lock: true });
      if (drawing.kind === 'general' && inSite.some((d) => d.kind === 'general' && isActive(d))) {
        throw new AppError('CONFLICT', 'This site already has its General drawing', {
          reason: 'GENERAL_EXISTS',
          siteId: site.id,
        });
      }
      const ordinal = nextOrdinal(inSite, drawing.kind);
      await tx.drawings.assignSite(projectId, drawing.id, site.id, ordinal);
      await tx.events.append({
        projectId,
        entity: EVENT_ENTITIES.siteDrawing,
        entityId: drawing.id,
        type: EVENT_TYPES.siteDrawingAssigned,
        actorId,
        payload: { siteId: site.id, siteName: site.name, kind: drawing.kind, ordinal },
      });
    });
  }
}

/** Withdraws a drawing that was never published from its site; its open revision is discarded. */
export class WithdrawSiteDrawingUseCase {
  constructor(
    private readonly uow: CadUnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(input: { projectId: string; drawingId: string; actorId: string }): Promise<void> {
    const { projectId, drawingId, actorId } = input;
    await this.uow.run(async (tx) => {
      const drawing: SiteDrawingRecord | null = await tx.drawings.find(projectId, drawingId, {
        lock: true,
      });
      if (!drawing) throw new AppError('NOT_FOUND', 'Drawing not found');
      if (!isActive(drawing)) {
        throw new AppError('CONFLICT', 'The drawing is already withdrawn', {
          reason: 'ALREADY_WITHDRAWN',
        });
      }
      if (await tx.revisions.findLatestPublished(projectId, drawing.id)) {
        throw new AppError('CONFLICT', 'A published drawing cannot be withdrawn', {
          reason: 'DRAWING_PUBLISHED',
        });
      }
      const open = await tx.revisions.findOpen(projectId, drawing.id);
      const locked = open ? await tx.revisions.find(projectId, open.id, { lock: true }) : null;
      if (locked) {
        await discardRevisionInTx(tx, {
          revision: locked,
          actorId,
          supersedingJobId: this.ids.next(),
        });
      }
      await tx.drawings.withdraw(projectId, drawing.id, actorId, this.clock.now());
      await tx.events.append({
        projectId,
        entity: EVENT_ENTITIES.siteDrawing,
        entityId: drawing.id,
        type: EVENT_TYPES.siteDrawingWithdrawn,
        actorId,
        payload: { siteId: drawing.siteId, kind: drawing.kind, ordinal: drawing.ordinal },
      });
    });
  }
}
