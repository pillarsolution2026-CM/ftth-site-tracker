import { LocaleSchema, RoleSchema } from '@ftth/shared';
import { and, asc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { AppError } from '../../../common/app-error.js';
import type { Database, DbHandle } from '../../../db/db.module.js';
import { DrizzleEventLog } from '../../../db/drizzle-event-log.js';
import { foreignKeyViolation, redactedDbError, uniqueViolation } from '../../../db/pg-errors.js';
import { assignments, refreshTokens, users, zones } from '../../../db/schema.js';
import type {
  AssignmentAdminRepository,
  AssignmentView,
  IdentityAdminTx,
  IdentityAdminUnitOfWork,
  NewAssignment,
  NewUser,
  UserAdminRepository,
  UserSummary,
} from '../domain/user-admin.js';

const userColumns = {
  id: users.id,
  email: users.email,
  displayName: users.displayName,
  locale: users.locale,
  isAdmin: users.isAdmin,
  isActive: users.isActive,
  createdAt: users.createdAt,
};

function toSummary(row: {
  id: string;
  email: string;
  displayName: string;
  locale: string;
  isAdmin: boolean;
  isActive: boolean;
  createdAt: Date;
}): UserSummary {
  return { ...row, locale: LocaleSchema.parse(row.locale) };
}

export class DrizzleUserAdminRepository implements UserAdminRepository {
  constructor(private readonly db: DbHandle) {}

  async list(): Promise<UserSummary[]> {
    const rows = await this.db
      .select(userColumns)
      .from(users)
      .orderBy(asc(users.displayName), asc(users.email));
    return rows.map(toSummary);
  }

  async findById(userId: string): Promise<UserSummary | null> {
    // Locks the row so a concurrent deactivation cannot slip between the check and the write.
    const [row] = await this.db
      .select(userColumns)
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .for('update');
    return row ? toSummary(row) : null;
  }

  async insert(user: NewUser): Promise<UserSummary> {
    try {
      const [row] = await this.db
        .insert(users)
        .values({ ...user, isAdmin: false, isActive: true })
        .returning(userColumns);
      if (!row) throw new Error('user insert returned no row');
      return toSummary(row);
    } catch (error) {
      if (uniqueViolation(error) !== null) {
        throw new AppError('CONFLICT', 'A user with this email already exists', {
          reason: 'EMAIL_TAKEN',
        });
      }
      // The driver error lists the query params, which include the password hash: never log them.
      throw redactedDbError(error, 'user insert');
    }
  }

  async setActive(userId: string, active: boolean): Promise<UserSummary | null> {
    const [row] = await this.db
      .update(users)
      .set({ isActive: active })
      .where(and(eq(users.id, userId), eq(users.isAdmin, false)))
      .returning(userColumns);
    return row ? toSummary(row) : null;
  }

  async revokeSessions(userId: string, at: Date): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: at })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  }
}

export class DrizzleAssignmentAdminRepository implements AssignmentAdminRepository {
  constructor(private readonly db: DbHandle) {}

  listForProject(projectId: string): Promise<AssignmentView[]> {
    return this.query(eq(assignments.projectId, projectId));
  }

  async insert(assignment: NewAssignment): Promise<AssignmentView> {
    let id: string;
    try {
      const [row] = await this.db
        .insert(assignments)
        .values(assignment)
        .returning({ id: assignments.id });
      if (!row) throw new Error('assignment insert returned no row');
      id = row.id;
    } catch (error) {
      const fk = foreignKeyViolation(error);
      if (fk === 'assignments_project_zone_fkey') {
        throw new AppError('VALIDATION_FAILED', 'The zone does not belong to this project', {
          reason: 'ZONE_NOT_IN_PROJECT',
        });
      }
      if (fk === 'assignments_project_id_fkey') {
        throw new AppError('NOT_FOUND', 'Project not found');
      }
      if (fk === 'assignments_user_id_fkey') throw new AppError('NOT_FOUND', 'User not found');
      if (uniqueViolation(error) !== null) {
        throw new AppError('CONFLICT', 'The user already has this role here', {
          reason: 'ALREADY_ASSIGNED',
        });
      }
      throw error;
    }
    const [view] = await this.query(eq(assignments.id, id));
    if (!view) throw new Error('assignment vanished after insert');
    return view;
  }

  async delete(projectId: string, assignmentId: string): Promise<AssignmentView | null> {
    const where = and(eq(assignments.id, assignmentId), eq(assignments.projectId, projectId));
    const [view] = await this.query(where);
    if (!view) return null;
    // Only the request whose DELETE removed the row reports it, so a concurrent removal cannot
    // write a second `assignment.removed` event.
    const deleted = await this.db
      .delete(assignments)
      .where(where)
      .returning({ id: assignments.id });
    return deleted.length > 0 ? view : null;
  }

  // The zone name is read for display only; zones are written by the projects module.
  private async query(where: SQL | undefined): Promise<AssignmentView[]> {
    const rows = await this.db
      .select({
        id: assignments.id,
        userId: assignments.userId,
        userEmail: users.email,
        userDisplayName: users.displayName,
        userIsActive: users.isActive,
        role: assignments.role,
        zoneId: assignments.zoneId,
        zoneName: zones.name,
        createdAt: assignments.createdAt,
      })
      .from(assignments)
      .innerJoin(users, eq(users.id, assignments.userId))
      .leftJoin(zones, eq(zones.id, assignments.zoneId))
      .where(where)
      .orderBy(asc(users.displayName), asc(assignments.role), sql`${zones.name} NULLS FIRST`);
    return rows.map((row) => ({ ...row, role: RoleSchema.parse(row.role) }));
  }
}

/** One database transaction: repositories and the event log share it. */
export class DrizzleIdentityAdminUnitOfWork implements IdentityAdminUnitOfWork {
  constructor(private readonly db: Database) {}

  run<T>(work: (tx: IdentityAdminTx) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) =>
      work({
        users: new DrizzleUserAdminRepository(tx),
        assignments: new DrizzleAssignmentAdminRepository(tx),
        events: new DrizzleEventLog(tx),
      }),
    );
  }
}
