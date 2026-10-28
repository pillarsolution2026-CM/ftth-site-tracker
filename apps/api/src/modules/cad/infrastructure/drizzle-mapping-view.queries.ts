import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import type { DbHandle } from '../../../db/db.module.js';
import { cadInserts, cadTexts } from '../../../db/schema.js';
import type {
  CadMappingViewQueries,
  MappingBlockGroup,
  MappingTextGroup,
} from '../domain/design-revision.repository.js';

/** Grouping behind the mapping screen; reads the rows the CAD worker extracted. */
export class DrizzleMappingViewQueries implements CadMappingViewQueries {
  constructor(private readonly db: DbHandle) {}

  async blocks(projectId: string, cadFileId: string): Promise<MappingBlockGroup[]> {
    const rows = await this.db
      .select({
        name: cadInserts.blockName,
        total: count(),
        layers: sql<string[]>`array_agg(DISTINCT ${cadInserts.layer} ORDER BY ${cadInserts.layer})`,
      })
      .from(cadInserts)
      .where(and(eq(cadInserts.projectId, projectId), eq(cadInserts.cadFileId, cadFileId)))
      .groupBy(cadInserts.blockName)
      .orderBy(asc(cadInserts.blockName));
    return rows.map((row) => ({ name: row.name, count: row.total, layers: row.layers }));
  }

  async texts(projectId: string, cadFileId: string, limit: number): Promise<MappingTextGroup[]> {
    // Space, tab, LF, CR: what `String.prototype.trim` removes from CAD text in practice.
    const trimmed = sql<string>`btrim(${cadTexts.text}, ' ' || chr(9) || chr(10) || chr(13))`;
    const rows = await this.db
      .select({ layer: cadTexts.layer, text: trimmed, total: count() })
      .from(cadTexts)
      .where(
        and(
          eq(cadTexts.projectId, projectId),
          eq(cadTexts.cadFileId, cadFileId),
          eq(cadTexts.readable, true),
          sql`${trimmed} <> ''`,
        ),
      )
      .groupBy(cadTexts.layer, trimmed)
      .orderBy(desc(count()), asc(cadTexts.layer), asc(trimmed))
      .limit(limit);
    return rows.map((row) => ({ layer: row.layer, text: row.text, count: row.total }));
  }
}
