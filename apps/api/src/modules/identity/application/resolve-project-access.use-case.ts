import { PROJECT_WIDE_ROLES } from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { MembershipRepository, ProjectAccess } from '../domain/membership.js';

export class ResolveProjectAccessUseCase {
  constructor(private readonly memberships: MembershipRepository) {}

  /** Throws FORBIDDEN unless the user is a platform admin or assigned to the project. */
  async execute(input: {
    userId: string;
    isAdmin: boolean;
    projectId: string;
  }): Promise<ProjectAccess> {
    const rows = await this.memberships.listForUserInProject(input.userId, input.projectId);
    if (rows.length === 0) {
      if (input.isAdmin) return { projectId: input.projectId, roles: ['admin'], zoneIds: [] };
      throw new AppError('FORBIDDEN', 'No access to this project');
    }

    const roles = [...new Set(rows.map((row) => row.role))];
    // Any project-wide role (admin/pm/qc) lifts the zone restriction.
    const projectWide = roles.some((role) => PROJECT_WIDE_ROLES.includes(role));
    const zoneIds = projectWide
      ? []
      : [...new Set(rows.flatMap((row) => (row.zoneId ? [row.zoneId] : [])))];
    return { projectId: input.projectId, roles, zoneIds };
  }
}
