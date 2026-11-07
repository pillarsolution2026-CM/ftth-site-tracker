import { asc, eq, getTableColumns, sql } from 'drizzle-orm';
import { AppError } from '../../../common/app-error.js';
import type { DbHandle } from '../../../db/db.module.js';
import { uniqueViolation } from '../../../db/pg-errors.js';
import { contractorRegistrations, contractors } from '../../../db/schema.js';
import type { ContractorPatch, ContractorRecord, ContractorSummary } from '../domain/contractor.js';
import type { ContractorRepository } from '../domain/contractor.repository.js';

type Row = typeof contractors.$inferSelect;

const toRecord = (row: Row): ContractorRecord => ({
  id: row.id,
  name: row.name,
  contactName: row.contactName,
  contactPhone: row.contactPhone,
  commercialRegister: row.commercialRegister,
  taxCard: row.taxCard,
  version: row.version,
  createdById: row.createdBy,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

function translate(error: unknown): never {
  if (error instanceof AppError) throw error;
  if (uniqueViolation(error) === 'contractors_name_key') {
    throw new AppError('CONFLICT', 'A contractor with this name already exists', {
      reason: 'CONTRACTOR_NAME_TAKEN',
    });
  }
  throw error;
}

export class DrizzleContractorRepository implements ContractorRepository {
  constructor(private readonly db: DbHandle) {}

  private select() {
    return this.db
      .select({
        contractor: getTableColumns(contractors),
        workOrderCount: sql<number>`(
          select count(*)::int from ${contractorRegistrations}
          where ${contractorRegistrations.contractorId} = ${contractors}.id)`,
      })
      .from(contractors);
  }

  async list(): Promise<ContractorSummary[]> {
    const rows = await this.select().orderBy(
      asc(sql`lower(${contractors.name})`),
      asc(contractors.id),
    );
    return rows.map((row) => ({ ...toRecord(row.contractor), workOrderCount: row.workOrderCount }));
  }

  async findById(
    contractorId: string,
    options?: { lock?: boolean },
  ): Promise<ContractorSummary | null> {
    const query = this.select().where(eq(contractors.id, contractorId));
    const [row] = await (options?.lock ? query.for('update', { of: contractors }) : query);
    return row ? { ...toRecord(row.contractor), workOrderCount: row.workOrderCount } : null;
  }

  async insert(contractor: ContractorRecord): Promise<void> {
    try {
      await this.db.insert(contractors).values({
        id: contractor.id,
        name: contractor.name,
        contactName: contractor.contactName,
        contactPhone: contractor.contactPhone,
        commercialRegister: contractor.commercialRegister,
        taxCard: contractor.taxCard,
        version: contractor.version,
        createdBy: contractor.createdById,
      });
    } catch (error) {
      translate(error);
    }
  }

  async update(contractorId: string, patch: ContractorPatch): Promise<ContractorRecord> {
    try {
      const [row] = await this.db
        .update(contractors)
        .set({ ...patch, version: sql`${contractors.version} + 1` })
        .where(eq(contractors.id, contractorId))
        .returning();
      if (!row) throw new AppError('NOT_FOUND', 'Contractor not found');
      return toRecord(row);
    } catch (error) {
      return translate(error);
    }
  }
}
