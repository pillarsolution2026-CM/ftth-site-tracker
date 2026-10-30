import { LocaleSchema } from '@ftth/shared';
import { asc, eq, sql } from 'drizzle-orm';
import type { Database, DbHandle } from '../../../db/db.module.js';
import { DrizzleEventLog } from '../../../db/drizzle-event-log.js';
import { projects, zones } from '../../../db/schema.js';
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

function toProject(row: typeof projects.$inferSelect): Project {
  return {
    id: row.id,
    name: row.name,
    client: row.client,
    crsEpsg: row.crsEpsg,
    currency: row.currency,
    locale: LocaleSchema.parse(row.locale),
  };
}

export class DrizzleProjectRepository implements ProjectAdminRepository {
  constructor(private readonly db: DbHandle) {}

  async findById(projectId: string): Promise<Project | null> {
    const [row] = await this.db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    return row ? toProject(row) : null;
  }

  async findByIdForUpdate(projectId: string): Promise<Project | null> {
    const [row] = await this.db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1)
      .for('update');
    return row ? toProject(row) : null;
  }

  async list(): Promise<Project[]> {
    const rows = await this.db.select().from(projects).orderBy(asc(projects.name));
    return rows.map(toProject);
  }

  async insert(project: NewProject): Promise<Project> {
    const [row] = await this.db.insert(projects).values(project).returning();
    if (!row) throw new Error('project insert returned no row');
    return toProject(row);
  }

  async update(projectId: string, changes: ProjectChanges): Promise<Project> {
    const [row] = await this.db
      .update(projects)
      .set(changes)
      .where(eq(projects.id, projectId))
      .returning();
    if (!row) throw new Error('project update returned no row');
    return toProject(row);
  }
}

export class DrizzleZoneRepository implements ZoneRepository {
  constructor(private readonly db: DbHandle) {}

  async listForProject(projectId: string): Promise<Zone[]> {
    return this.db
      .select({
        id: zones.id,
        name: zones.name,
        hasBoundary: sql<boolean>`${zones.geom} IS NOT NULL`,
      })
      .from(zones)
      .where(eq(zones.projectId, projectId))
      .orderBy(asc(zones.name));
  }

  async insert(projectId: string, name: string): Promise<Zone> {
    const [row] = await this.db
      .insert(zones)
      .values({ projectId, name })
      .returning({ id: zones.id, name: zones.name });
    if (!row) throw new Error('zone insert returned no row');
    return { ...row, hasBoundary: false };
  }
}

/** One database transaction: repositories and the event log share it. */
export class DrizzleProjectAdminUnitOfWork implements ProjectAdminUnitOfWork {
  constructor(private readonly db: Database) {}

  run<T>(work: (tx: ProjectAdminTx) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) =>
      work({
        projects: new DrizzleProjectRepository(tx),
        zones: new DrizzleZoneRepository(tx),
        events: new DrizzleEventLog(tx),
      }),
    );
  }
}
