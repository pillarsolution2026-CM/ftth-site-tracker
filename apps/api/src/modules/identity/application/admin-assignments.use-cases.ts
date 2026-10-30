import { ADMIN_EVENT_TYPES, type CreateAssignmentRequest } from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type {
  AssignmentAdminRepository,
  AssignmentView,
  IdentityAdminUnitOfWork,
} from '../domain/user-admin.js';

/** The caller checks that the project exists (projects module) before listing. */
export class ListAssignmentsUseCase {
  constructor(private readonly assignments: AssignmentAdminRepository) {}

  execute(projectId: string): Promise<AssignmentView[]> {
    return this.assignments.listForProject(projectId);
  }
}

/**
 * Assigns an active non-admin to a project. The request schema already enforces the zone rule
 * (zone-scoped roles need one, project-wide roles must not have one) and excludes `admin`.
 */
export class CreateAssignmentUseCase {
  constructor(private readonly uow: IdentityAdminUnitOfWork) {}

  execute(
    input: CreateAssignmentRequest & { projectId: string },
    actorId: string,
  ): Promise<AssignmentView> {
    return this.uow.run(async (tx) => {
      const user = await tx.users.findById(input.userId);
      if (!user) throw new AppError('NOT_FOUND', 'User not found');
      if (user.isAdmin) {
        throw new AppError('VALIDATION_FAILED', 'Admins already see every project', {
          reason: 'USER_IS_ADMIN',
        });
      }
      if (!user.isActive) {
        throw new AppError('VALIDATION_FAILED', 'The user is deactivated', {
          reason: 'USER_INACTIVE',
        });
      }
      const created = await tx.assignments.insert({
        projectId: input.projectId,
        userId: input.userId,
        role: input.role,
        zoneId: input.zoneId,
      });
      await tx.events.append({
        projectId: input.projectId,
        entity: 'assignment',
        entityId: created.id,
        type: ADMIN_EVENT_TYPES.assignmentCreated,
        actorId,
        payload: { userId: created.userId, role: created.role, zoneId: created.zoneId },
      });
      return created;
    });
  }
}

export class RemoveAssignmentUseCase {
  constructor(private readonly uow: IdentityAdminUnitOfWork) {}

  execute(input: { projectId: string; assignmentId: string }, actorId: string): Promise<void> {
    return this.uow.run(async (tx) => {
      const removed = await tx.assignments.delete(input.projectId, input.assignmentId);
      if (!removed) throw new AppError('NOT_FOUND', 'Assignment not found');
      await tx.events.append({
        projectId: input.projectId,
        entity: 'assignment',
        entityId: removed.id,
        type: ADMIN_EVENT_TYPES.assignmentRemoved,
        actorId,
        payload: { userId: removed.userId, role: removed.role, zoneId: removed.zoneId },
      });
    });
  }
}
