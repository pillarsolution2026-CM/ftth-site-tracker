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
    // Fail closed: a zone-scoped role (supervisor, contractor) without a zone grants nothing.
    const rows = all.filter((row) => grantsAccess(row, PROJECT_WIDE_ROLES));
    if (rows.length === 0) {
      if (input.isAdmin) {
        return { projectId: input.projectId, roles: ['admin'], scope: { kind: 'project' } };
      }
      throw new AppError('FORBIDDEN', 'No access to this project');
    }

    const roles = [...new Set(rows.map((row) => row.role))];
    // Any project-wide role (admin/pm/qc) lifts the zone restriction.
    if (roles.some((role) => PROJECT_WIDE_ROLES.includes(role))) {
      return { projectId: input.projectId, roles, scope: { kind: 'project' } };
    }
    const zoneIds = [...new Set(rows.flatMap((row) => (row.zoneId ? [row.zoneId] : [])))];
    return { projectId: input.projectId, roles, scope: { kind: 'zones', zoneIds } };
  }
}
