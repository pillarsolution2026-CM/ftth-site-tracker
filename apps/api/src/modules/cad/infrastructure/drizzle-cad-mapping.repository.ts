import { and, eq } from 'drizzle-orm';
import { toDecimalText } from '../../../common/decimal-text.js';
import type { DbHandle } from '../../../db/db.module.js';
import { cadMappings } from '../../../db/schema.js';
import type { CadMappingRecord } from '../domain/cad-mapping.js';
import type { CadMappingRepository } from '../domain/design-revision.repository.js';

type Row = typeof cadMappings.$inferSelect;

function toRecord(row: Row): CadMappingRecord {
  return {
    cadFileId: row.cadFileId,
    projectId: row.projectId,
    rules: row.rules,
    crsEpsg: row.crsEpsg,
    drawingUnit: row.drawingUnit,
    metresPerUnit: toDecimalText(row.metresPerUnit),
    version: row.version,
    updatedById: row.updatedBy,
    updatedAt: row.updatedAt,
  };
}

const inFile = (projectId: string, cadFileId: string) =>
  and(eq(cadMappings.projectId, projectId), eq(cadMappings.cadFileId, cadFileId));

export class DrizzleCadMappingRepository implements CadMappingRepository {
  constructor(private readonly db: DbHandle) {}

  async find(
    projectId: string,
    cadFileId: string,
    options?: { lock?: boolean },
  ): Promise<CadMappingRecord | null> {
    const query = this.db.select().from(cadMappings).where(inFile(projectId, cadFileId));
    const [row] = await (options?.lock ? query.for('update') : query);
    return row ? toRecord(row) : null;
  }

  async insert(mapping: Omit<CadMappingRecord, 'version'>): Promise<CadMappingRecord> {
    const [row] = await this.db
      .insert(cadMappings)
      .values({
        cadFileId: mapping.cadFileId,
        projectId: mapping.projectId,
        rules: mapping.rules,
        crsEpsg: mapping.crsEpsg,
        drawingUnit: mapping.drawingUnit,
        metresPerUnit: mapping.metresPerUnit,
        version: 1,
        updatedBy: mapping.updatedById,
      })
      .returning();
    if (!row) throw new Error('cad_mappings insert returned no row');
    return toRecord(row);
  }

  async update(
    mapping: Omit<CadMappingRecord, 'version'>,
    expectedVersion: number,
  ): Promise<CadMappingRecord | null> {
    const [row] = await this.db
      .update(cadMappings)
      .set({
        rules: mapping.rules,
        crsEpsg: mapping.crsEpsg,
        drawingUnit: mapping.drawingUnit,
        metresPerUnit: mapping.metresPerUnit,
        version: expectedVersion + 1,
        updatedBy: mapping.updatedById,
      })
      .where(
        and(inFile(mapping.projectId, mapping.cadFileId), eq(cadMappings.version, expectedVersion)),
      )
      .returning();
    return row ? toRecord(row) : null;
  }
}
