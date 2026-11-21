import { RoleSchema } from '@ftth/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../../../db/db.module.js';
import { assignments, projects, supervisorSites, users } from '../../../db/schema.js';
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
        // ADR-054: a supervisor's sites in this project, in a stable order (empty for others).
        siteIds: sql<string[] | null>`CASE WHEN ${assignments.role} = 'supervisor' THEN (
          SELECT array_agg(${supervisorSites.siteId} ORDER BY ${supervisorSites.siteId})
          FROM ${supervisorSites}
          WHERE ${supervisorSites.userId} = ${assignments.userId}
            AND ${supervisorSites.projectId} = ${assignments.projectId}
        ) END`,
      })
      .from(assignments)
      .innerJoin(projects, eq(projects.id, assignments.projectId))
      // A deactivated user keeps their assignments but they grant nothing (ADR-026).
      .innerJoin(users, and(eq(users.id, assignments.userId), eq(users.isActive, true)))
      .where(where)
      .orderBy(projects.name, assignments.role);
    return rows.map((row) => ({
      ...row,
      role: RoleSchema.parse(row.role),
      siteIds: row.siteIds ?? [],
    }));
  }
}
