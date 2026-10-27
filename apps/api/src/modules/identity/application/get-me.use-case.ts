import { PROJECT_WIDE_ROLES, type MeResponse, type ProjectMembership } from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { AssignmentRow, MembershipRepository } from '../domain/membership.js';
import type { UserRepository } from '../domain/user.js';

/** One membership per (project, role); zone ids aggregated, empty for project-wide roles. */
export function aggregateMemberships(rows: AssignmentRow[]): ProjectMembership[] {
  const byKey = new Map<string, ProjectMembership>();
  for (const row of rows) {
    const key = `${row.projectId}:${row.role}`;
    let membership = byKey.get(key);
    if (!membership) {
      membership = {
        projectId: row.projectId,
        projectName: row.projectName,
        role: row.role,
        zoneIds: [],
      };
      byKey.set(key, membership);
    }
    const projectWide = PROJECT_WIDE_ROLES.includes(row.role);
    if (!projectWide && row.zoneId && !membership.zoneIds.includes(row.zoneId)) {
      membership.zoneIds.push(row.zoneId);
    }
  }
  return [...byKey.values()];
}

export class GetMeUseCase {
  constructor(
    private readonly users: UserRepository,
    private readonly memberships: MembershipRepository,
  ) {}

  async execute(userId: string): Promise<MeResponse> {
    const user = await this.users.findById(userId);
    if (!user || !user.isActive) throw new AppError('TOKEN_INVALID', 'Account is not available');
    const rows = await this.memberships.listForUser(userId);
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      locale: user.locale,
      isAdmin: user.isAdmin,
      memberships: aggregateMemberships(rows),
    };
  }
}
