import { PROJECT_WIDE_ROLES } from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import {
  grantsAccess,
  type MembershipRepository,
  type ProjectAccess,
} from '../domain/membership.js';

export class ResolveProjectAccessUseCase {
  constructor(private readonly memberships: MembershipRepository) {}

  /** Throws FORBIDDEN unless the user is a platform admin or assigned to the project. */
  async execute(input: {
    userId: string;
    isAdmin: boolean;
    projectId: string;
  }): Promise<ProjectAccess> {
    const all = await this.memberships.listForUserInProject(input.userId, input.projectId);
    // A supervisor row grants access (his sites may be none); the retired contractor role grants nothing.
    const rows = all.filter((row) => grantsAccess(row, PROJECT_WIDE_ROLES));
    if (rows.length === 0) {
      if (input.isAdmin) {
        return {
          projectId: input.projectId,
          roles: ['admin'],
          scope: { kind: 'project' },
          grants: [],
        };
      }
      throw new AppError('FORBIDDEN', 'No access to this project');
    }

    const roles = [...new Set(rows.map((row) => row.role))];
    const grants = rows.map((row) => ({ role: row.role, siteIds: row.siteIds }));
    // Any project-wide role (admin/pm/qc) lifts the site restriction.
    if (roles.some((role) => PROJECT_WIDE_ROLES.includes(role))) {
      return { projectId: input.projectId, roles, scope: { kind: 'project' }, grants };
    }
    const siteIds = [...new Set(rows.flatMap((row) => row.siteIds))];
    return { projectId: input.projectId, roles, scope: { kind: 'sites', siteIds }, grants };
  }
}
