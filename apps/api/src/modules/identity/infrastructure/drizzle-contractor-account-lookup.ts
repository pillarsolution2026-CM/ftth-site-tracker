import { eq } from 'drizzle-orm';
import type { DbHandle } from '../../../db/db.module.js';
import { contractorAccounts, contractors } from '../../../db/schema.js';
import type { ContractorAccountLookup } from '../domain/user.js';

/** Reads `contractor_accounts` (migration 0028) to tell a contractor account from other users. */
export class DrizzleContractorAccountLookup implements ContractorAccountLookup {
  constructor(private readonly db: DbHandle) {}

  async contractorOf(userId: string): Promise<{ id: string; name: string } | null> {
    const [row] = await this.db
      .select({ id: contractors.id, name: contractors.name })
      .from(contractorAccounts)
      .innerJoin(contractors, eq(contractors.id, contractorAccounts.contractorId))
      .where(eq(contractorAccounts.userId, userId))
      .limit(1);
    return row ?? null;
  }
}
