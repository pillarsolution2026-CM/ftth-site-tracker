import { hasPermission, PROJECT_WIDE_ROLES, type Permission, type Role } from '@ftth/shared';

/** One `assignments` row joined with the project name. */
export interface AssignmentRow {
  projectId: string;
  projectName: string;
  role: Role;
  /** A supervisor's sites in this project (ADR-054); empty for every other role. */
  siteIds: string[];
}

export interface MembershipRepository {
  listForUser(userId: string): Promise<AssignmentRow[]>;
  listForUserInProject(userId: string, projectId: string): Promise<AssignmentRow[]>;
}

/** Which part of a project a user may touch. Site scope is explicit so it can never default to wide. */
export type AccessScope = { kind: 'project' } | { kind: 'sites'; siteIds: string[] };

/** What a user may do inside one project. */
export interface ProjectAccess {
  projectId: string;
  roles: Role[];
  /** Union of every role's reach; use `scopeForPermission` for writes. */
  scope: AccessScope;
  /** The assignments behind `roles`, kept so a scope can be computed per permission. */
  grants: { role: Role; siteIds: string[] }[];
}

/**
 * A row grants access when its role is project-wide or a supervisor's (ADR-054: a supervisor
 * assignment grants project access, his reach being his sites; with none he sees nothing). Any
 * other role (the retired project `contractor` assignments, ADR-053) grants nothing.
 */
export function grantsAccess(row: AssignmentRow, projectWideRoles: readonly Role[]): boolean {
  return projectWideRoles.includes(row.role) || row.role === 'supervisor';
}

/**
 * Where the user may use `permission`: only the assignments whose role grants it count. A
 * project-wide role that grants it opens the whole project; otherwise only the sites of granting
 * supervisor assignments (possibly none: an empty site list, never null for a granting
 * supervisor). Null when no assignment grants it. (Security review, Phase 3: a QC member who is
 * also a supervisor of site B must not write outside site B.)
 */
export function scopeForPermission(
  access: ProjectAccess,
  permission: Permission,
  isPlatformAdmin: boolean,
): AccessScope | null {
  if (isPlatformAdmin) return { kind: 'project' };
  const granting = access.grants.filter((grant) => hasPermission([grant.role], permission));
  if (granting.some((grant) => PROJECT_WIDE_ROLES.includes(grant.role))) return { kind: 'project' };
  if (granting.length === 0) return null;
  const siteIds = [...new Set(granting.flatMap((grant) => grant.siteIds))];
  return { kind: 'sites', siteIds };
}
