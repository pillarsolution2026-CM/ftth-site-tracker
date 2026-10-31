import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import { AppError } from '../../../common/app-error.js';
import type { DbHandle } from '../../../db/db.module.js';
import { contractItems, contracts, projects, workOrderItems } from '../../../db/schema.js';
import type { ApprovedContract, ContractItemInfo, Reservations } from '../domain/contract-lines.js';
import { Decimal } from '../domain/decimal.js';
import type { ContractCatalog } from '../domain/work-order.repository.js';

/**
 * Reads the project's contract straight from its tables, in the caller's transaction (the lock
 * and the reservation sums must share it). Same pattern as the projects module's contract
 * reference; read-only.
 */
export class DrizzleContractCatalog implements ContractCatalog {
  constructor(private readonly db: DbHandle) {}

  async loadApproved(projectId: string, options?: { lock?: boolean }): Promise<ApprovedContract> {
    const [project] = await this.db
      .select({ contractId: projects.contractId })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!project) throw new AppError('NOT_FOUND', 'Project not found');
    if (!project.contractId) {
      throw new AppError('CONFLICT', 'The project has no contract', { reason: 'NO_CONTRACT' });
    }

    const query = this.db
      .select({ id: contracts.id, number: contracts.number, status: contracts.status })
      .from(contracts)
      .where(eq(contracts.id, project.contractId));
    const [contract] = await (options?.lock ? query.for('update') : query);
    if (!contract) {
      throw new AppError('CONFLICT', 'The project has no contract', { reason: 'NO_CONTRACT' });
    }
    if (contract.status !== 'approved') {
      throw new AppError('CONFLICT', 'The contract must be approved first', {
        reason: 'CONTRACT_NOT_APPROVED',
      });
    }

    const rows = await this.db
      .select()
      .from(contractItems)
      .where(and(eq(contractItems.contractId, contract.id), eq(contractItems.kind, 'item')))
      .orderBy(asc(contractItems.lineNo));
    const items: ContractItemInfo[] = [];
    for (const row of rows) {
      // Priced items always carry these (CHECK on contract_items); skip anything incomplete.
      if (
        row.description === null ||
        row.unit === null ||
        row.quantity === null ||
        row.unitPrice === null ||
        row.workType === null
      ) {
        continue;
      }
      items.push({
        id: row.id,
        lineNo: row.lineNo,
        code: row.code,
        description: row.description,
        unit: row.unit,
        unitPrice: Decimal.parse(row.unitPrice),
        workType: row.workType,
        quantity: Decimal.parse(row.quantity),
      });
    }
    return { id: contract.id, number: contract.number, items };
  }

  async reservations(contractId: string): Promise<Reservations> {
    const rows = await this.db
      .select({
        contractItemId: workOrderItems.contractItemId,
        reserved: sql<string>`sum(${workOrderItems.quantity})::text`,
      })
      .from(workOrderItems)
      .where(
        and(eq(workOrderItems.contractId, contractId), isNotNull(workOrderItems.contractItemId)),
      )
      .groupBy(workOrderItems.contractItemId);
    const reserved = new Map<string, Decimal>();
    for (const row of rows) {
      if (row.contractItemId !== null)
        reserved.set(row.contractItemId, Decimal.parse(row.reserved));
    }
    return reserved;
  }
}
