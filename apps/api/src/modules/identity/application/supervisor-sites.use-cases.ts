import {
  SUPERVISOR_SITES_EVENT,
  type SupervisorSitesResponse,
  type SupervisorWithSites,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type {
  SupervisorSitesRepository,
  SupervisorSitesUnitOfWork,
} from '../domain/supervisor-sites.js';

/** GET /projects/:projectId/supervisor-sites (ADR-054): the project's sites and its supervisors. */
export class ListSupervisorSitesUseCase {
  constructor(private readonly sites: SupervisorSitesRepository) {}

  async execute(projectId: string): Promise<SupervisorSitesResponse> {
    const [sites, supervisors] = await Promise.all([
      this.sites.listSites(projectId),
      this.sites.listSupervisors(projectId),
    ]);
    return { sites, supervisors };
  }
}

/** PUT /projects/:projectId/supervisors/:userId/sites: replaces his sites in one transaction. */
export class ReplaceSupervisorSitesUseCase {
  constructor(private readonly uow: SupervisorSitesUnitOfWork) {}

  execute(
    input: { projectId: string; userId: string; siteIds: readonly string[] },
    actorId: string,
  ): Promise<SupervisorWithSites> {
    return this.uow.run(async (tx) => {
      await tx.sites.lockSupervisorAssignments(input.projectId, input.userId);
      const before = await tx.sites.findSupervisor(input.projectId, input.userId);
      if (!before) throw new AppError('NOT_FOUND', 'Supervisor not found in this project');
      const known = new Set(await tx.sites.existingSiteIds(input.projectId, input.siteIds));
      const foreign = input.siteIds.filter((id) => !known.has(id));
      if (foreign.length > 0) {
        throw new AppError(
          'VALIDATION_FAILED',
          'A site is not a site of this project',
          {
            reason: 'SITE_NOT_IN_PROJECT',
            siteIds: foreign,
          },
          422,
        );
      }
      await tx.sites.replace(input.projectId, input.userId, input.siteIds, actorId);
      const after = await tx.sites.findSupervisor(input.projectId, input.userId);
      if (!after) throw new Error('supervisor vanished after replacing his sites');
      await tx.events.append({
        projectId: input.projectId,
        entity: 'supervisor_sites',
        entityId: input.userId,
        type: SUPERVISOR_SITES_EVENT,
        actorId,
        payload: { before: before.siteIds, after: after.siteIds },
      });
      return after;
    });
  }
}
