import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import {
  PLACEMENT_ITEM_MAX_NAMES,
  type PlacementDrawing,
  type PlacementItem,
  type PlacementLine,
} from '@ftth/shared';
import type { DbHandle } from '../../../db/db.module.js';
import { cadInserts, cadTexts } from '../../../db/schema.js';
import { rowsOf } from '../../../db/sql.js';
import type {
  CadMappingViewQueries,
  MappingBlockGroup,
  MappingTextGroup,
  PlacementDrawingLimits,
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

  async placementDrawing(
    projectId: string,
    cadFileId: string,
    limits: PlacementDrawingLimits,
  ): Promise<PlacementDrawing> {
    const [revision] = await rowsOf<{ id: string; mpu: string }>(
      this.db,
      sql`SELECT id, metres_per_unit AS mpu FROM design_revisions
          WHERE project_id = ${projectId} AND cad_file_id = ${cadFileId}
            AND status IN ('draft', 'published')
          ORDER BY created_at DESC LIMIT 1`,
    );
    if (!revision) return { revisionId: null, items: [], lines: [], truncated: false };
    const mpu = Number(revision.mpu);

    // The drawn centre the build starts from (ADR-032/035): an insert's drawn centre (else its
    // position, as the worker reads it), a text's position, or
    // the centre of the joint extents of a shape group (`attrs.shapes`, else the source curve).
    // Names: each short readable text goes to its nearest item within the radius (a hint only).
    const items = await rowsOf<{
      handle: string;
      feature_type: PlacementItem['featureType'];
      code: string | null;
      names: string[] | null;
      layer: string;
      x: number;
      y: number;
    }>(
      this.db,
      sql`WITH item AS (
            SELECT * FROM (
              SELECT df.source_handle AS handle, df.feature_type, df.code, df.layer,
                     CASE df.source_kind WHEN 'insert' THEN ST_X(COALESCE(ci.centre, ci.position))
                                         WHEN 'text' THEN ST_X(ct.position)
                                         ELSE (ST_XMin(sh.box) + ST_XMax(sh.box)) / 2 END AS x,
                     CASE df.source_kind WHEN 'insert' THEN ST_Y(COALESCE(ci.centre, ci.position))
                                         WHEN 'text' THEN ST_Y(ct.position)
                                         ELSE (ST_YMin(sh.box) + ST_YMax(sh.box)) / 2 END AS y
              FROM design_features df
              LEFT JOIN cad_inserts ci
                ON df.source_kind = 'insert' AND ci.cad_file_id = ${cadFileId}
               AND ci.handle = df.source_handle
              LEFT JOIN cad_texts ct
                ON df.source_kind = 'text' AND ct.cad_file_id = ${cadFileId}
               AND ct.handle = df.source_handle
              LEFT JOIN LATERAL (
                SELECT ST_Extent(cc.geom) AS box FROM cad_curves cc
                WHERE df.source_kind = 'curve' AND cc.cad_file_id = ${cadFileId}
                  AND cc.handle = ANY (
                    CASE WHEN jsonb_typeof(df.attrs -> 'shapes') = 'array'
                         THEN ARRAY(SELECT jsonb_array_elements_text(df.attrs -> 'shapes'))
                         ELSE ARRAY[df.source_handle] END)
              ) sh ON true
              WHERE df.revision_id = ${revision.id} AND df.project_id = ${projectId}
                AND df.feature_type <> 'route'
            ) AS located
            WHERE x IS NOT NULL AND y IS NOT NULL
          ),
          -- One plain join within the radius, then the nearest item per text, computed once and
          -- grouped by item (a per-text nearest search, or a per-item subquery over this CTE,
          -- took 20-50 s on Rabaa: 186 items, ~1 000 texts).
          named AS MATERIALIZED (
            SELECT DISTINCT ON (t.handle) i.handle, btrim(t.text) AS name,
                   ST_Distance(ST_Force2D(t.position), i.p) AS d
            FROM cad_texts t
            JOIN (SELECT handle, ST_MakePoint(x, y) AS p FROM item) i
              ON ST_DWithin(ST_Force2D(t.position), i.p, ${limits.nameRadiusM / mpu}::float8)
            WHERE t.cad_file_id = ${cadFileId} AND t.readable
              AND char_length(btrim(t.text)) BETWEEN 1 AND ${limits.nameMaxChars}
            ORDER BY t.handle, d, i.handle
          )
          SELECT item.*, grouped.names
          FROM item
          LEFT JOIN (
            SELECT handle, array_agg(name ORDER BY d, name) AS names
            FROM (SELECT DISTINCT ON (handle, name) handle, name, d FROM named
                  ORDER BY handle, name, d) AS once
            GROUP BY handle
          ) AS grouped ON grouped.handle = item.handle
          ORDER BY feature_type, code NULLS LAST, handle`,
    );

    const tolerance = limits.toleranceM / mpu;
    const lines = await rowsOf<{ coords: PlacementLine; total: string }>(
      this.db,
      sql`SELECT ST_AsGeoJSON(simple, 6)::json -> 'coordinates' AS coords, count(*) OVER () AS total
          FROM (
            SELECT df.source_handle,
                   ST_Simplify(ST_Force2D(cc.geom), ${tolerance}::float8) AS simple
            FROM design_features df
            JOIN cad_curves cc ON cc.cad_file_id = ${cadFileId} AND cc.handle = df.source_handle
            WHERE df.revision_id = ${revision.id} AND df.project_id = ${projectId}
              AND df.feature_type = 'route'
          ) AS route
          WHERE ST_NPoints(simple) >= 2
          ORDER BY source_handle
          LIMIT ${limits.maxLines}`,
    );
    return {
      revisionId: revision.id,
      items: items.map((row) => ({
        handle: row.handle,
        featureType: row.feature_type,
        code: row.code,
        names: (row.names ?? []).slice(0, PLACEMENT_ITEM_MAX_NAMES),
        layer: row.layer,
        x: Number(row.x),
        y: Number(row.y),
      })),
      lines: lines.map((row) => row.coords),
      truncated: lines.length > 0 && Number(lines[0]?.total) > lines.length,
    };
  }
}
