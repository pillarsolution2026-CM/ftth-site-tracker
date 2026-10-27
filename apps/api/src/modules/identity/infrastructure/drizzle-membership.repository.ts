import { RoleSchema } from '@ftth/shared';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../../../db/db.module.js';
import { assignments, projects } from '../../../db/schema.js';
import type { AssignmentRow, MembershipRepository } from '../domain/membership.js';

export class DrizzleMembershipRepository implements MembershipRepository {
  constructor(private readonly db: Database) {}

  listForUser(userId: string): Promise<AssignmentRow[]> {
    return this.query(eq(assignments.userId, userId));
  }

  listForUserInProject(userId: string, projectId: string): Promise<AssignmentRow[]> {
    return this.query(and(eq(assignments.userId, userId), eq(assignments.projectId, projectId)));
  }

  // assignments belong to identity; the join only reads the project's display name.
  private async query(where: ReturnType<typeof and>): Promise<AssignmentRow[]> {
    const rows = await this.db
      .select({
        projectId: assignments.projectId,
        projectName: projects.name,
        role: assignments.role,
        zoneId: assignments.zoneId,
      })
      .from(assignments)
      .innerJoin(projects, eq(projects.id, assignments.projectId))
      .where(where)
      .orderBy(projects.name, assignments.role);
    return rows.map((row) => ({ ...row, role: RoleSchema.parse(row.role) }));
  }
}
