import { hasPermission, PROJECT_WIDE_ROLES, type Permission, type Role } from '@ftth/shared';

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
  /** Union of every role's reach; use `scopeForPermission` for writes. */
  scope: AccessScope;
  /** The assignments behind `roles`, kept so a scope can be computed per permission. */
  grants: { role: Role; zoneId: string | null }[];
}

/** A row grants access only if its role is project-wide or it names a zone (fail closed). */
export function grantsAccess(row: AssignmentRow, projectWideRoles: readonly Role[]): boolean {
  return projectWideRoles.includes(row.role) || row.zoneId !== null;
}

/**
 * Where the user may use `permission`: only the assignments whose role grants it count. A
 * project-wide role that grants it opens the whole project; otherwise only the zones of granting
 * zone-scoped assignments. Null when no assignment grants it. (Security review, Phase 3: a QC
 * member who is also a supervisor of zone B must not write outside zone B.)
 */
export function scopeForPermission(
  access: ProjectAccess,
  permission: Permission,
  isPlatformAdmin: boolean,
): AccessScope | null {
  if (isPlatformAdmin) return { kind: 'project' };
  const granting = access.grants.filter((grant) => hasPermission([grant.role], permission));
  if (granting.some((grant) => PROJECT_WIDE_ROLES.includes(grant.role))) return { kind: 'project' };
  const zoneIds = [...new Set(granting.flatMap((grant) => (grant.zoneId ? [grant.zoneId] : [])))];
  return zoneIds.length > 0 ? { kind: 'zones', zoneIds } : null;
}
