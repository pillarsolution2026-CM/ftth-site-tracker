import {
  CadCurveEntityTypeSchema,
  type CadCurveListQuery,
  type CadCurvePage,
  type CadInsert,
  type CadInsertListQuery,
  type CadInsertPage,
  type CadLayer,
  type CadText,
  type CadTextListQuery,
  type CadTextPage,
} from '@ftth/shared';
import { and, asc, count, eq, ilike, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { DbHandle } from '../../../db/db.module.js';
import { cadCurves, cadInserts, cadLayers, cadTexts } from '../../../db/schema.js';
import type { CadExtractionQueries } from '../domain/cad-file.repository.js';

/** `%`, `_` and `\` in user input must match themselves in ILIKE. */
const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (char) => `\\${char}`);

const point = (column: AnyColumn) => ({
  x: sql<number>`ST_X(${column})`,
  y: sql<number>`ST_Y(${column})`,
  z: sql<number>`ST_Z(${column})`,
});

/**
 * Reads the tables the CAD worker fills (the API never writes them). Geometry leaves the database
 * only as numbers extracted with ST_*; drawing coordinates, SRID 0.
 */
export class DrizzleCadExtractionQueries implements CadExtractionQueries {
  constructor(private readonly db: DbHandle) {}

  async layers(projectId: string, cadFileId: string): Promise<CadLayer[]> {
    const rows = await this.db
      .select()
      .from(cadLayers)
      .where(and(eq(cadLayers.projectId, projectId), eq(cadLayers.cadFileId, cadFileId)))
      .orderBy(asc(cadLayers.name));
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      aciColor: row.aciColor,
      trueColor: row.trueColor,
      linetype: row.linetype,
      isOn: row.isOn,
      isFrozen: row.isFrozen,
      isLocked: row.isLocked,
      entityCounts: row.entityCounts,
      entityTotal: row.entityTotal,
    }));
  }

  async inserts(
    projectId: string,
    cadFileId: string,
    query: CadInsertListQuery,
  ): Promise<CadInsertPage> {
    const conditions: SQL[] = [
      eq(cadInserts.projectId, projectId),
      eq(cadInserts.cadFileId, cadFileId),
    ];
    if (query.layer) conditions.push(eq(cadInserts.layer, query.layer));
    if (query.blockName) conditions.push(eq(cadInserts.blockName, query.blockName));
    const where = and(...conditions);

    const rows = await this.db
      .select({ row: cadInserts, ...point(cadInserts.position) })
      .from(cadInserts)
      .where(where)
      .orderBy(asc(cadInserts.layer), asc(cadInserts.handle))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);
    const items: CadInsert[] = rows.map(({ row, x, y, z }) => ({
      id: row.id,
      handle: row.handle,
      layer: row.layer,
      blockName: row.blockName,
      position: { x, y, z },
      rotation: row.rotation,
      scale: { x: row.scaleX, y: row.scaleY, z: row.scaleZ },
      aciColor: row.aciColor,
      attributes: row.attributes,
    }));
    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total: await this.total(cadInserts, where),
    };
  }

  async texts(projectId: string, cadFileId: string, query: CadTextListQuery): Promise<CadTextPage> {
    const conditions: SQL[] = [
      eq(cadTexts.projectId, projectId),
      eq(cadTexts.cadFileId, cadFileId),
    ];
    if (query.layer) conditions.push(eq(cadTexts.layer, query.layer));
    if (query.kind) conditions.push(eq(cadTexts.kind, query.kind));
    if (query.readable !== undefined) conditions.push(eq(cadTexts.readable, query.readable));
    if (query.q) conditions.push(ilike(cadTexts.text, `%${escapeLike(query.q)}%`));
    const where = and(...conditions);

    const rows = await this.db
      .select({ row: cadTexts, ...point(cadTexts.position) })
      .from(cadTexts)
      .where(where)
      .orderBy(asc(cadTexts.layer), asc(cadTexts.handle))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);
    const items: CadText[] = rows.map(({ row, x, y, z }) => ({
      id: row.id,
      handle: row.handle,
      kind: row.kind,
      layer: row.layer,
      position: { x, y, z },
      height: row.height,
      rotation: row.rotation,
      rawText: row.rawText,
      text: row.text,
      readable: row.readable,
      style: row.style,
      font: row.font,
      aciColor: row.aciColor,
    }));
    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total: await this.total(cadTexts, where),
    };
  }

  async curves(
    projectId: string,
    cadFileId: string,
    query: CadCurveListQuery,
  ): Promise<CadCurvePage> {
    const conditions: SQL[] = [
      eq(cadCurves.projectId, projectId),
      eq(cadCurves.cadFileId, cadFileId),
    ];
    if (query.layer) conditions.push(eq(cadCurves.layer, query.layer));
    if (query.entityType) conditions.push(eq(cadCurves.entityType, query.entityType));
    const where = and(...conditions);

    const rows = await this.db
      .select({
        row: cadCurves,
        minX: sql<number>`ST_XMin(${cadCurves.geom})`,
        minY: sql<number>`ST_YMin(${cadCurves.geom})`,
        maxX: sql<number>`ST_XMax(${cadCurves.geom})`,
        maxY: sql<number>`ST_YMax(${cadCurves.geom})`,
      })
      .from(cadCurves)
      .where(where)
      .orderBy(asc(cadCurves.layer), asc(cadCurves.handle))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);
    const items = rows.map(({ row, minX, minY, maxX, maxY }) => ({
      id: row.id,
      handle: row.handle,
      entityType: CadCurveEntityTypeSchema.parse(row.entityType),
      layer: row.layer,
      vertexCount: row.vertexCount ?? 2,
      isClosed: row.isClosed,
      length: row.length ?? 0,
      bbox: { minX, minY, maxX, maxY },
      approximated: row.flattenTolerance !== null,
      aciColor: row.aciColor,
    }));
    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total: await this.total(cadCurves, where),
    };
  }

  private async total(
    table: typeof cadInserts | typeof cadTexts | typeof cadCurves,
    where: SQL | undefined,
  ): Promise<number> {
    const [row] = await this.db.select({ value: count() }).from(table).where(where);
    return row?.value ?? 0;
  }
}
