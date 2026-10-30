import {
  ADMIN_EVENT_TYPES,
  type CreateProjectRequest,
  type CreateZoneRequest,
  type UpdateProjectRequest,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type {
  Project,
  ProjectAdminRepository,
  ProjectAdminUnitOfWork,
  ProjectChanges,
  Zone,
} from '../domain/project.js';

export class ListProjectsUseCase {
  constructor(private readonly projects: ProjectAdminRepository) {}

  execute(): Promise<Project[]> {
    return this.projects.list();
  }
}

export class CreateProjectUseCase {
  constructor(private readonly uow: ProjectAdminUnitOfWork) {}

  execute(input: CreateProjectRequest, actorId: string): Promise<Project> {
    return this.uow.run(async (tx) => {
      const project = await tx.projects.insert(input);
      await tx.events.append({
        projectId: project.id,
        entity: 'project',
        entityId: project.id,
        type: ADMIN_EVENT_TYPES.projectCreated,
        actorId,
        payload: { ...input },
      });
      return project;
    });
  }
}

/** Name, client and locale only. Writes `{ before, after }` of the fields that really changed. */
export class UpdateProjectUseCase {
  constructor(private readonly uow: ProjectAdminUnitOfWork) {}

  execute(input: UpdateProjectRequest & { projectId: string }, actorId: string): Promise<Project> {
    return this.uow.run(async (tx) => {
      const current = await tx.projects.findByIdForUpdate(input.projectId);
      if (!current) throw new AppError('NOT_FOUND', 'Project not found');

      const changes: ProjectChanges = {};
      const before: Record<string, unknown> = {};
      for (const key of ['name', 'client', 'locale'] as const) {
        const next = input[key];
        if (next !== undefined && next !== current[key]) {
          Object.assign(changes, { [key]: next });
          before[key] = current[key];
        }
      }
      if (Object.keys(changes).length === 0) return current;

      const updated = await tx.projects.update(input.projectId, changes);
      await tx.events.append({
        projectId: input.projectId,
        entity: 'project',
        entityId: input.projectId,
        type: ADMIN_EVENT_TYPES.projectUpdated,
        actorId,
        payload: { before, after: changes },
      });
      return updated;
    });
  }
}

export class ListZonesUseCase {
  constructor(private readonly uow: ProjectAdminUnitOfWork) {}

  execute(projectId: string): Promise<Zone[]> {
    return this.uow.run(async (tx) => {
      if (!(await tx.projects.findById(projectId))) {
        throw new AppError('NOT_FOUND', 'Project not found');
      }
      return tx.zones.listForProject(projectId);
    });
  }
}

/**
 * Names a zone so zone-scoped roles can be assigned. No boundary: drawing it belongs to the Phase 2
 * zones screen. Names are unique per project, ignoring case and surrounding spaces.
 */
export class CreateZoneUseCase {
  constructor(private readonly uow: ProjectAdminUnitOfWork) {}

  execute(input: CreateZoneRequest & { projectId: string }, actorId: string): Promise<Zone> {
    return this.uow.run(async (tx) => {
      // The project row lock serialises zone creation, so the name check below cannot race.
      if (!(await tx.projects.findByIdForUpdate(input.projectId))) {
        throw new AppError('NOT_FOUND', 'Project not found');
      }
      const existing = await tx.zones.listForProject(input.projectId);
      const wanted = input.name.toLocaleLowerCase();
      if (existing.some((zone) => zone.name.trim().toLocaleLowerCase() === wanted)) {
        throw new AppError('CONFLICT', 'A zone with this name already exists', {
          reason: 'ZONE_NAME_TAKEN',
        });
      }
      const zone = await tx.zones.insert(input.projectId, input.name);
      await tx.events.append({
        projectId: input.projectId,
        entity: 'zone',
        entityId: zone.id,
        type: ADMIN_EVENT_TYPES.zoneCreated,
        actorId,
        payload: { name: zone.name },
      });
      return zone;
    });
  }
}
