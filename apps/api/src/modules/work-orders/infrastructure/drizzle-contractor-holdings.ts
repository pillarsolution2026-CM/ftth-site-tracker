import { eq, sql } from 'drizzle-orm';
import type { DbHandle } from '../../../db/db.module.js';
import { contractorLines, contractorRegistrations } from '../../../db/schema.js';
import { Decimal } from '../domain/decimal.js';
import type { ContractorHoldings } from '../domain/work-order.repository.js';

/** Reads the contractor tables (migration 0013) for the checks that protect them (ADR-036). */
export class DrizzleContractorHoldings implements ContractorHoldings {
  constructor(private readonly db: DbHandle) {}

  async heldQuantity(workOrderItemId: string): Promise<Decimal> {
    const [row] = await this.db
      .select({ held: sql<string>`coalesce(sum(${contractorLines.quantity}), 0)::text` })
      .from(contractorLines)
      .where(eq(contractorLines.workOrderItemId, workOrderItemId));
    return Decimal.parse(row?.held ?? '0');
  }

  async lineCount(workOrderItemId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(contractorLines)
      .where(eq(contractorLines.workOrderItemId, workOrderItemId));
    return row?.count ?? 0;
  }

  async registrationCount(workOrderId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(contractorRegistrations)
      .where(eq(contractorRegistrations.workOrderId, workOrderId));
    return row?.count ?? 0;
  }
}
