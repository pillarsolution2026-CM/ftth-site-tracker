import type { Role } from '@ftth/shared';

/** One `assignments` row joined with the project name. */
export interface AssignmentRow {
  projectId: string;
  projectName: string;
  role: Role;
  zoneId: string | null;
}

export interface MembershipRepository {
  listForUser(userId: string): Promise<AssignmentRow[]>;
  listForUserInProject(userId: string, projectId: string): Promise<AssignmentRow[]>;
}

/** What a user may do inside one project. `zoneIds` is empty for project-wide access. */
export interface ProjectAccess {
  projectId: string;
  roles: Role[];
  zoneIds: string[];
}
