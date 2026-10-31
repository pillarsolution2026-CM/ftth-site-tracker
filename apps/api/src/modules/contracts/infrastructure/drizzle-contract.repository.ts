import { and, asc, eq, getTableColumns, sql } from 'drizzle-orm';
import { AppError } from '../../../common/app-error.js';
import type { DbHandle } from '../../../db/db.module.js';
import { restrictViolation, uniqueViolation } from '../../../db/pg-errors.js';
import { contractItems, contracts, projects } from '../../../db/schema.js';
import { Decimal } from '../../work-orders/domain/decimal.js';
import {
  Contract,
  type ContractHeader,
  type ContractLine,
  type HeaderPatch,
} from '../domain/contract.js';
import type { ContractRepository, ContractSummaryRow } from '../domain/contract.repository.js';

type ContractRow = typeof contracts.$inferSelect;
type LineRow = typeof contractItems.$inferSelect;

const INSERT_CHUNK = 500;

const toHeader = (row: ContractRow): ContractHeader => ({
  id: row.id,
  number: row.number,
  name: row.name,
  client: row.client,
  currency: row.currency,
  startsOn: row.startsOn,
  durationDays: row.durationDays,
  notes: row.notes,
  status: row.status,
  approvedAt: row.approvedAt,
  approvedById: row.approvedBy,
  version: row.version,
  createdById: row.createdBy,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toLine = (row: LineRow): ContractLine => ({
  id: row.id,
  lineNo: row.lineNo,
  kind: row.kind,
  code: row.code,
  description: row.description,
  unit: row.unit,
  quantity: row.quantity === null ? null : Decimal.parse(row.quantity),
  unitPrice: row.unitPrice === null ? null : Decimal.parse(row.unitPrice),
  workType: row.workType,
  source: row.source,
  sourceRow: row.sourceRow,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const lineValues = (contractId: string, line: ContractLine) => ({
  id: line.id,
  contractId,
  lineNo: line.lineNo,
  kind: line.kind,
  code: line.code,
  description: line.description,
  unit: line.unit,
  quantity: line.quantity?.toString() ?? null,
  unitPrice: line.unitPrice?.toString() ?? null,
  workType: line.workType,
  source: line.source,
  sourceRow: line.sourceRow,
});

/**
 * Maps the constraints that matter to client-visible conflicts. The approval trigger
 * (`restrict_violation`) is a safety net: the domain already refuses writes to approved contracts.
 */
function translate(error: unknown): never {
  if (error instanceof AppError) throw error;
  const constraint = uniqueViolation(error);
  if (constraint === 'contracts_number_key') {
    throw new AppError('CONFLICT', 'Contract number is already used', {
      reason: 'DUPLICATE_NUMBER',
    });
  }
  if (constraint === 'contract_items_line_no_key') {
    throw new AppError('CONFLICT', 'Line number is already used', { reason: 'LINE_TAKEN' });
  }
  if (restrictViolation(error)) {
    throw new AppError('CONFLICT', 'The contract is approved; its BOQ is locked', {
      reason: 'CONTRACT_APPROVED',
    });
  }
  throw error;
}

export class DrizzleContractRepository implements ContractRepository {
  constructor(private readonly db: DbHandle) {}

  async list(): Promise<ContractSummaryRow[]> {
    const rows = await this.db
      .select({
        contract: getTableColumns(contracts),
        itemCount: sql<number>`count(${contractItems.id}) filter (where ${contractItems.kind} = 'item')::int`,
        total: sql<string>`coalesce(sum(${contractItems.amount}) filter (where ${contractItems.kind} = 'item'), 0)::text`,
        projectCount: sql<number>`(
          select count(*)::int from ${projects} where ${projects.contractId} = ${contracts.id})`,
      })
      .from(contracts)
      .leftJoin(contractItems, eq(contractItems.contractId, contracts.id))
      .groupBy(contracts.id)
      .orderBy(asc(contracts.number));
    return rows.map((row) => ({
      header: toHeader(row.contract),
      itemCount: row.itemCount,
      total: Decimal.parse(row.total),
      projectCount: row.projectCount,
    }));
  }

  async exists(contractId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: contracts.id })
      .from(contracts)
      .where(eq(contracts.id, contractId));
    return row !== undefined;
  }

  async findById(contractId: string, options?: { lock?: boolean }): Promise<Contract | null> {
    const query = this.db.select().from(contracts).where(eq(contracts.id, contractId));
    const [row] = await (options?.lock ? query.for('update') : query);
    if (!row) return null;
    const lines = await this.db
      .select()
      .from(contractItems)
      .where(eq(contractItems.contractId, contractId))
      .orderBy(asc(contractItems.lineNo));
    return new Contract(toHeader(row), lines.map(toLine));
  }

  async projectCount(contractId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(projects)
      .where(eq(projects.contractId, contractId));
    return row?.count ?? 0;
  }

  async insert(contract: Contract): Promise<void> {
    const { header } = contract;
    try {
      await this.db.insert(contracts).values({
        id: header.id,
        number: header.number,
        name: header.name,
        client: header.client,
        currency: header.currency,
        startsOn: header.startsOn,
        durationDays: header.durationDays,
        notes: header.notes,
        status: header.status,
        version: header.version,
        createdBy: header.createdById,
      });
    } catch (error) {
      translate(error);
    }
  }

  async updateHeader(contractId: string, patch: HeaderPatch): Promise<ContractHeader> {
    try {
      const [row] = await this.db
        .update(contracts)
        .set({ ...patch, version: sql`${contracts.version} + 1` })
        .where(eq(contracts.id, contractId))
        .returning();
      if (!row) throw new AppError('NOT_FOUND', 'Contract not found');
      return toHeader(row);
    } catch (error) {
      return translate(error);
    }
  }

  async approve(contractId: string, actorId: string, at: Date): Promise<void> {
    try {
      await this.db
        .update(contracts)
        .set({
          status: 'approved',
          approvedAt: at,
          approvedBy: actorId,
          version: sql`${contracts.version} + 1`,
        })
        .where(eq(contracts.id, contractId));
    } catch (error) {
      translate(error);
    }
  }

  async insertLine(contractId: string, line: ContractLine): Promise<void> {
    try {
      await this.db.insert(contractItems).values(lineValues(contractId, line));
    } catch (error) {
      translate(error);
    }
    await this.bumpVersion(contractId);
  }

  async updateLine(contractId: string, line: ContractLine): Promise<void> {
    const values = lineValues(contractId, line);
    try {
      const updated = await this.db
        .update(contractItems)
        .set({
          kind: values.kind,
          code: values.code,
          description: values.description,
          unit: values.unit,
          quantity: values.quantity,
          unitPrice: values.unitPrice,
          workType: values.workType,
        })
        .where(and(eq(contractItems.contractId, contractId), eq(contractItems.id, line.id)))
        .returning({ id: contractItems.id });
      if (updated.length === 0) throw new AppError('NOT_FOUND', 'Contract item not found');
    } catch (error) {
      translate(error);
    }
    await this.bumpVersion(contractId);
  }

  async deleteLine(contractId: string, lineId: string): Promise<void> {
    try {
      const deleted = await this.db
        .delete(contractItems)
        .where(and(eq(contractItems.contractId, contractId), eq(contractItems.id, lineId)))
        .returning({ id: contractItems.id });
      if (deleted.length === 0) throw new AppError('NOT_FOUND', 'Contract item not found');
    } catch (error) {
      translate(error);
    }
    await this.bumpVersion(contractId);
  }

  async replaceLines(contractId: string, lines: readonly ContractLine[]): Promise<void> {
    try {
      await this.db.delete(contractItems).where(eq(contractItems.contractId, contractId));
      for (let start = 0; start < lines.length; start += INSERT_CHUNK) {
        await this.db
          .insert(contractItems)
          .values(lines.slice(start, start + INSERT_CHUNK).map((l) => lineValues(contractId, l)));
      }
    } catch (error) {
      translate(error);
    }
    await this.bumpVersion(contractId);
  }

  private async bumpVersion(contractId: string): Promise<void> {
    await this.db
      .update(contracts)
      .set({ version: sql`${contracts.version} + 1` })
      .where(eq(contracts.id, contractId));
  }
}
