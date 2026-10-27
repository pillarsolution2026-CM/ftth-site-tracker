import { MeResponseSchema } from '@ftth/shared';
import { eq } from 'drizzle-orm';
import type { Database } from '../../../db/db.module.js';
import { projects } from '../../../db/schema.js';
import type { Project, ProjectRepository } from '../domain/project.js';

export class DrizzleProjectRepository implements ProjectRepository {
  constructor(private readonly db: Database) {}

  async findById(projectId: string): Promise<Project | null> {
    const [row] = await this.db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      client: row.client,
      crsEpsg: row.crsEpsg,
      currency: row.currency,
      locale: MeResponseSchema.shape.locale.parse(row.locale),
    };
  }
}
