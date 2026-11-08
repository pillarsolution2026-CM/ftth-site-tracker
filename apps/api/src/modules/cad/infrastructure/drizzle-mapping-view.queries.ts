import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import {
  PLACEMENT_ITEM_MAX_NAMES,
  POINT_FEATURE_TYPES,
  type MappingRule,
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

/**
 * Closed shapes on one point layer closer than this (metres) are one symbol (ADR-033). Mirrors
 * `SHAPE_TOUCH_M` of the CAD worker (`design_build.py`): technical tuning, not a business rule.
 */
const SHAPE_TOUCH_M = 0.05;

/** Space, tab, LF, CR: what `String.prototype.trim` removes from CAD text in practice. */
const TRIM_CHARS = sql`' ' || chr(9) || chr(10) || chr(13)`;

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
    const trimmed = sql<string>`btrim(${cadTexts.text}, ${TRIM_CHARS})`;
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
    const [mapping] = await rowsOf<{
      rules: MappingRule[];
      mpu: string;
      version: number;
      status: string;
    }>(
      this.db,
      sql`SELECT m.rules, m.metres_per_unit AS mpu, m.version, f.status
          FROM cad_mappings m
          JOIN cad_files f ON f.project_id = m.project_id AND f.id = m.cad_file_id
          WHERE m.project_id = ${projectId} AND m.cad_file_id = ${cadFileId}`,
    );
    if (!mapping) return { mappingVersion: null, items: [], lines: [], truncated: false };
    const empty = { mappingVersion: mapping.version, items: [], lines: [], truncated: false };
    // While a (re)run is in flight the rows of an earlier run are about to be replaced: show none.
    if (mapping.status !== 'processed') return empty;

    const mpu = Number(mapping.mpu);
    const rules = JSON.stringify(mapping.rules);
    const pointTypes = sql`ARRAY[${sql.join(
      POINT_FEATURE_TYPES.map((type) => sql`${type}`),
      sql`, `,
    )}]::text[]`;

    // The classification of the build (`design_build.py`) over the extracted rows, in drawing
    // units: a block rule wins over the layer rule for inserts; text rules match trimmed,
    // lower-cased text on one layer; closed shapes on a point layer touching within 0.05 m are
    // one item keyed by the smallest handle, at the centre of the joint extents.
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
      sql`WITH layer_rule AS (
            SELECT DISTINCT ON (r ->> 'layer') r ->> 'layer' AS layer, r ->> 'target' AS target
            FROM jsonb_array_elements(${rules}::jsonb) r WHERE r ->> 'source' = 'layer'
          ),
          block_rule AS (
            SELECT DISTINCT ON (r ->> 'block') r ->> 'block' AS block, r ->> 'target' AS target
            FROM jsonb_array_elements(${rules}::jsonb) r WHERE r ->> 'source' = 'block'
          ),
          text_rule AS (
            SELECT DISTINCT ON (r ->> 'layer', lower(btrim(r ->> 'text', ${TRIM_CHARS})))
                   r ->> 'layer' AS layer, lower(btrim(r ->> 'text', ${TRIM_CHARS})) AS key,
                   r ->> 'target' AS target
            FROM jsonb_array_elements(${rules}::jsonb) r
            WHERE r ->> 'source' = 'text' AND r ->> 'target' = ANY (${pointTypes})
          ),
          point_layer AS (SELECT layer, target FROM layer_rule WHERE target = ANY (${pointTypes})),
          inserted AS (
            SELECT ci.handle, COALESCE(b.target, l.target) AS feature_type, NULL::text AS code,
                   ci.layer, ST_X(COALESCE(ci.centre, ci.position)) AS x,
                   ST_Y(COALESCE(ci.centre, ci.position)) AS y
            FROM cad_inserts ci
            LEFT JOIN block_rule b ON b.block = ci.block_name
            LEFT JOIN layer_rule l ON l.layer = ci.layer
            WHERE ci.cad_file_id = ${cadFileId} AND ci.project_id = ${projectId}
              AND COALESCE(b.target, l.target) = ANY (${pointTypes})
          ),
          lettered AS (
            SELECT ct.handle, tr.target AS feature_type, btrim(ct.text, ${TRIM_CHARS}) AS code,
                   ct.layer, ST_X(ct.position) AS x, ST_Y(ct.position) AS y
            FROM cad_texts ct
            JOIN text_rule tr ON tr.layer = ct.layer
                             AND tr.key = lower(btrim(ct.text, ${TRIM_CHARS}))
            WHERE ct.cad_file_id = ${cadFileId} AND ct.project_id = ${projectId} AND ct.readable
          ),
          shape AS (
            SELECT cc.handle, cc.layer, pl.target, cc.geom,
                   ST_Expand(ST_Envelope(ST_Force2D(cc.geom)), ${SHAPE_TOUCH_M / 2 / mpu}::float8) AS env
            FROM cad_curves cc
            JOIN point_layer pl ON pl.layer = cc.layer
            WHERE cc.cad_file_id = ${cadFileId} AND cc.project_id = ${projectId}
              AND cc.is_closed AND cc.vertex_count >= 2
          ),
          clustered AS (
            SELECT shape.*, ST_ClusterDBSCAN(env, 0, 1) OVER (PARTITION BY layer) AS cluster_id
            FROM shape
          ),
          joined_shape AS (
            SELECT min(handle COLLATE "C") AS handle, target, layer, ST_Extent(geom) AS box
            FROM clustered
            GROUP BY layer, cluster_id, target
          ),
          shaped AS (
            SELECT handle, target AS feature_type, NULL::text AS code, layer,
                   (ST_XMin(box) + ST_XMax(box)) / 2 AS x,
                   (ST_YMin(box) + ST_YMax(box)) / 2 AS y
            FROM joined_shape
          ),
          item AS (
            SELECT * FROM inserted
            UNION ALL SELECT * FROM lettered
            UNION ALL SELECT * FROM shaped
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
      sql`WITH route_layer AS (
            SELECT DISTINCT r ->> 'layer' AS layer
            FROM jsonb_array_elements(${rules}::jsonb) r
            WHERE r ->> 'source' = 'layer' AND r ->> 'target' = 'route'
          )
          SELECT ST_AsGeoJSON(simple, 6)::json -> 'coordinates' AS coords, count(*) OVER () AS total
          FROM (
            SELECT cc.handle,
                   ST_Simplify(ST_Force2D(cc.geom), ${tolerance}::float8) AS simple
            FROM cad_curves cc
            JOIN route_layer rl ON rl.layer = cc.layer
            WHERE cc.cad_file_id = ${cadFileId} AND cc.project_id = ${projectId}
              AND cc.length > 0
          ) AS route
          WHERE ST_NPoints(simple) >= 2
          ORDER BY handle
          LIMIT ${limits.maxLines}`,
    );
    return {
      mappingVersion: mapping.version,
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
