import type { AdminUser, Assignment } from '@ftth/shared';
import type { AssignmentView, UserSummary } from '../../identity/domain/user-admin.js';

export function toAdminUserDto(user: UserSummary): AdminUser {
  return { ...user, createdAt: user.createdAt.toISOString() };
}

export function toAssignmentDto(assignment: AssignmentView): Assignment {
  return { ...assignment, createdAt: assignment.createdAt.toISOString() };
}
