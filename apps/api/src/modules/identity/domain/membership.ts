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

/** Which part of a project a user may touch. Zone scope is explicit so it can never default to wide. */
export type AccessScope = { kind: 'project' } | { kind: 'zones'; zoneIds: string[] };

/** What a user may do inside one project. */
export interface ProjectAccess {
  projectId: string;
  roles: Role[];
  scope: AccessScope;
}

/** A row grants access only if its role is project-wide or it names a zone (fail closed). */
export function grantsAccess(row: AssignmentRow, projectWideRoles: readonly Role[]): boolean {
  return projectWideRoles.includes(row.role) || row.zoneId !== null;
}
