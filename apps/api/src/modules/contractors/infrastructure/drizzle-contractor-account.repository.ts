import { LocaleSchema } from '@ftth/shared';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { AppError } from '../../../common/app-error.js';
import type { Database, DbHandle } from '../../../db/db.module.js';
import { DrizzleEventLog } from '../../../db/drizzle-event-log.js';
import { redactedDbError, uniqueViolation } from '../../../db/pg-errors.js';
import {
  contractorAccounts,
  contractorRegistrations,
  refreshTokens,
  users,
} from '../../../db/schema.js';
import type {
  ContractorAccountRecord,
  ContractorAccountRepository,
  ContractorAccountTx,
  ContractorAccountUnitOfWork,
  NewContractorAccount,
} from '../domain/contractor-account.js';

const accountColumns = {
  userId: users.id,
  email: users.email,
  displayName: users.displayName,
  locale: users.locale,
  isActive: users.isActive,
  createdAt: users.createdAt,
};

type AccountRow = {
  userId: string;
  email: string;
  displayName: string;
  locale: string;
  isActive: boolean;
  createdAt: Date;
};

const toRecord = (row: AccountRow): ContractorAccountRecord => ({
  ...row,
  locale: LocaleSchema.parse(row.locale),
});

/**
 * Writes `users` and `contractor_accounts` together. The user table belongs to the identity
 * module; this module only creates a plain non-admin user for its own account row, in the same
 * transaction, exactly like the admin-created users.
 */
export class DrizzleContractorAccountRepository implements ContractorAccountRepository {
  constructor(private readonly db: DbHandle) {}

  async contractorOfRegistration(
    projectId: string,
    registrationId: string,
  ): Promise<string | null> {
    const [row] = await this.db
      .select({ contractorId: contractorRegistrations.contractorId })
      .from(contractorRegistrations)
      .where(
        and(
          eq(contractorRegistrations.id, registrationId),
          eq(contractorRegistrations.projectId, projectId),
        ),
      )
      .limit(1);
    return row?.contractorId ?? null;
  }

  async list(contractorId: string): Promise<ContractorAccountRecord[]> {
    const rows = await this.db
      .select(accountColumns)
      .from(contractorAccounts)
      .innerJoin(users, eq(users.id, contractorAccounts.userId))
      .where(eq(contractorAccounts.contractorId, contractorId))
      .orderBy(asc(users.displayName), asc(users.email));
    return rows.map(toRecord);
  }

  async findOwn(contractorId: string, userId: string): Promise<ContractorAccountRecord | null> {
    // Locks the user row so a concurrent stop or restart cannot slip between the check and the write.
    const [row] = await this.db
      .select(accountColumns)
      .from(contractorAccounts)
      .innerJoin(users, eq(users.id, contractorAccounts.userId))
      .where(and(eq(contractorAccounts.contractorId, contractorId), eq(users.id, userId)))
      .limit(1)
      .for('update', { of: users });
    return row ? toRecord(row) : null;
  }

  async insert(
    contractorId: string,
    account: NewContractorAccount,
    createdBy: string,
  ): Promise<ContractorAccountRecord> {
    try {
      const [user] = await this.db
        .insert(users)
        .values({ ...account, isAdmin: false, isActive: true })
        .returning(accountColumns);
      if (!user) throw new Error('user insert returned no row');
      await this.db
        .insert(contractorAccounts)
        .values({ userId: user.userId, contractorId, createdBy });
      return toRecord(user);
    } catch (error) {
      if (uniqueViolation(error) !== null) {
        throw new AppError('CONFLICT', 'A user with this email already exists', {
          reason: 'EMAIL_TAKEN',
        });
      }
      if (error instanceof AppError) throw error;
      // The driver error lists the query params, which include the password hash: never log them.
      throw redactedDbError(error, 'contractor account insert');
    }
  }

  async setActive(userId: string, active: boolean): Promise<ContractorAccountRecord | null> {
    const [row] = await this.db
      .update(users)
      .set({ isActive: active })
      .where(and(eq(users.id, userId), eq(users.isAdmin, false)))
      .returning(accountColumns);
    return row ? toRecord(row) : null;
  }

  async revokeSessions(userId: string, at: Date): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: at })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  }
}

export class DrizzleContractorAccountUnitOfWork implements ContractorAccountUnitOfWork {
  constructor(private readonly db: Database) {}

  run<T>(work: (tx: ContractorAccountTx) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) =>
      work({
        accounts: new DrizzleContractorAccountRepository(tx),
        events: new DrizzleEventLog(tx),
      }),
    );
  }
}
