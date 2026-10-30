import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { DomainEventInput } from '../../../common/event-log.port.js';
import type {
  NewProject,
  Project,
  ProjectAdminRepository,
  ProjectAdminTx,
  ProjectAdminUnitOfWork,
  ProjectChanges,
  Zone,
  ZoneRepository,
} from '../domain/project.js';
import {
  CreateProjectUseCase,
  CreateZoneUseCase,
  UpdateProjectUseCase,
} from './admin-projects.use-cases.js';

const ACTOR = '00000000-0000-4000-8000-000000000001';

class FakeProjects implements ProjectAdminRepository {
  readonly rows: Project[] = [];
  async findById(id: string) {
    return this.rows.find((row) => row.id === id) ?? null;
  }
  findByIdForUpdate(id: string) {
    return this.findById(id);
  }
  async list() {
    return [...this.rows];
  }
  async insert(project: NewProject) {
    const row = { ...project, id: randomUUID() };
    this.rows.push(row);
    return row;
  }
  async update(id: string, changes: ProjectChanges) {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row) throw new Error('missing');
    Object.assign(row, changes);
    return { ...row };
  }
}

class FakeZones implements ZoneRepository {
  readonly rows: (Zone & { projectId: string })[] = [];
  async listForProject(projectId: string) {
    return this.rows.filter((row) => row.projectId === projectId);
  }
  async insert(projectId: string, name: string) {
    const row = { id: randomUUID(), projectId, name, hasBoundary: false };
    this.rows.push(row);
    return row;
  }
}

class FakeUow implements ProjectAdminUnitOfWork {
  readonly projects = new FakeProjects();
  readonly zones = new FakeZones();
  readonly events: DomainEventInput[] = [];
  run<T>(work: (tx: ProjectAdminTx) => Promise<T>): Promise<T> {
    return work({
      projects: this.projects,
      zones: this.zones,
      events: { append: async (event) => void this.events.push(event) },
    });
  }
}

const NEW_PROJECT = {
  name: 'P',
  client: 'C',
  crsEpsg: 32636,
  currency: 'EGP',
  locale: 'ar',
} as const;

describe('UpdateProjectUseCase', () => {
  it('logs only the fields that really changed', async () => {
    const uow = new FakeUow();
    const project = await new CreateProjectUseCase(uow).execute(NEW_PROJECT, ACTOR);
    await new UpdateProjectUseCase(uow).execute(
      { projectId: project.id, name: 'P', client: 'New client' },
      ACTOR,
    );
    expect(uow.events.at(-1)).toMatchObject({
      type: 'project.updated',
      payload: { before: { client: 'C' }, after: { client: 'New client' } },
    });
  });

  it('writes no event when nothing changes, and 404s for a missing project', async () => {
    const uow = new FakeUow();
    const project = await new CreateProjectUseCase(uow).execute(NEW_PROJECT, ACTOR);
    await new UpdateProjectUseCase(uow).execute({ projectId: project.id, locale: 'ar' }, ACTOR);
    expect(uow.events.map((event) => event.type)).toEqual(['project.created']);
    await expect(
      new UpdateProjectUseCase(uow).execute({ projectId: ACTOR, name: 'X' }, ACTOR),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('CreateZoneUseCase', () => {
  it('refuses a name already used in the project, ignoring case', async () => {
    const uow = new FakeUow();
    const project = await new CreateProjectUseCase(uow).execute(NEW_PROJECT, ACTOR);
    const create = new CreateZoneUseCase(uow);
    await create.execute({ projectId: project.id, name: 'Sector A' }, ACTOR);
    await expect(
      create.execute({ projectId: project.id, name: 'sector a' }, ACTOR),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(create.execute({ projectId: ACTOR, name: 'Z' }, ACTOR)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
