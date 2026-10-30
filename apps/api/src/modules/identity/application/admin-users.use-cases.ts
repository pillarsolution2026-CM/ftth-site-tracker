import { ADMIN_EVENT_TYPES, type CreateUserRequest } from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type {
  IdentityAdminUnitOfWork,
  UserAdminRepository,
  UserSummary,
} from '../domain/user-admin.js';
import type { Clock, PasswordHasher } from './ports.js';

export class ListUsersUseCase {
  constructor(private readonly users: UserAdminRepository) {}

  execute(): Promise<UserSummary[]> {
    return this.users.list();
  }
}

/** Creates a non-admin user. The password is hashed like `create-admin` (argon2id) and never logged. */
export class CreateUserUseCase {
  constructor(
    private readonly uow: IdentityAdminUnitOfWork,
    private readonly hasher: PasswordHasher,
  ) {}

  async execute(input: CreateUserRequest, actorId: string): Promise<UserSummary> {
    const passwordHash = await this.hasher.hash(input.password);
    return this.uow.run(async (tx) => {
      const user = await tx.users.insert({
        email: input.email,
        displayName: input.displayName,
        passwordHash,
        locale: input.locale,
      });
      await tx.events.append({
        entity: 'user',
        entityId: user.id,
        type: ADMIN_EVENT_TYPES.userCreated,
        actorId,
        payload: { email: user.email, displayName: user.displayName, locale: user.locale },
      });
      return user;
    });
  }
}

/**
 * Deactivates or reactivates a non-admin. Admins are managed by the CLI only, and an admin cannot
 * lock themself out. Deactivation also ends the user's sessions.
 */
export class SetUserActiveUseCase {
  constructor(
    private readonly uow: IdentityAdminUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(input: { userId: string; active: boolean }, actorId: string): Promise<UserSummary> {
    if (input.userId === actorId) {
      throw new AppError('FORBIDDEN', 'You cannot change your own account here');
    }
    return this.uow.run(async (tx) => {
      const current = await tx.users.findById(input.userId);
      if (!current) throw new AppError('NOT_FOUND', 'User not found');
      if (current.isAdmin) throw new AppError('FORBIDDEN', 'Admins are managed by the CLI');
      if (current.isActive === input.active) return current;

      const updated = await tx.users.setActive(input.userId, input.active);
      if (!updated) throw new AppError('NOT_FOUND', 'User not found');
      if (!input.active) await tx.users.revokeSessions(input.userId, this.clock.now());
      await tx.events.append({
        entity: 'user',
        entityId: input.userId,
        type: input.active ? ADMIN_EVENT_TYPES.userReactivated : ADMIN_EVENT_TYPES.userDeactivated,
        actorId,
      });
      return updated;
    });
  }
}
