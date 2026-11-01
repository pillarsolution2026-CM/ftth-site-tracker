import type {
  AsBuiltEdit,
  AsBuiltEditDetail,
  AsBuiltEditListQuery,
  AsBuiltEditListResponse,
  AsBuiltFeatureState,
  AsBuiltLengthsResponse,
  AsBuiltRouteLength,
  AsBuiltStateResponse,
} from '@ftth/shared';
import { sql } from 'drizzle-orm';
import { toDecimalText, toDecimalTextOrNull } from '../../../common/decimal-text.js';
import type { DbHandle } from '../../../db/db.module.js';
import { rowsOf } from '../../../db/sql.js';
import type {
  AsBuiltEditFeed,
  AsBuiltLengthsPort,
  AsBuiltReadQueries,
  AsBuiltScope,
  AsBuiltStateReader,
} from '../application/ports.js';
import { isBaseCurrent } from '../domain/review.js';
import {
  EDIT_COLUMNS,
  editReadScope,
  mapEdit,
  mapState,
  parseGeometry,
  stateScope,
  type EditRow,
  type StateRow,
  stateQuery,
} from './asbuilt-sql.js';

/** Every query is bound to `project_id` and to the caller's scope. */
export class DrizzleAsBuiltReadQueries
  implements AsBuiltReadQueries, AsBuiltEditFeed, AsBuiltStateReader, AsBuiltLengthsPort
{
  constructor(private readonly db: DbHandle) {}

  private async latestRevisionId(projectId: string): Promise<string | null> {
    const [row] = await rowsOf<{ id: string }>(
      this.db,
      sql`SELECT id FROM design_revisions
          WHERE project_id = ${projectId} AND status = 'published'
          ORDER BY rev_no DESC LIMIT 1`,
    );
    return row?.id ?? null;
  }

  async listEdits(
    projectId: string,
    scope: AsBuiltScope,
    query: AsBuiltEditListQuery,
  ): Promise<AsBuiltEditListResponse> {
    const filter = sql`e.project_id = ${projectId}
      AND ${query.status ? sql`e.status = ${query.status}` : sql`true`}
      AND ${query.featureId ? sql`e.feature_id = ${query.featureId}` : sql`true`}
      AND ${editReadScope(projectId, scope)}`;
    const [count] = await rowsOf<{ total: string }>(
      this.db,
      sql`SELECT count(*)::text AS total FROM asbuilt_edits e WHERE ${filter}`,
    );
    const rows = await rowsOf<EditRow>(
      this.db,
      sql`SELECT ${EDIT_COLUMNS}
          FROM asbuilt_edits e JOIN users u ON u.id = e.user_id
          WHERE ${filter}
          ORDER BY e.received_at DESC, e.sync_seq DESC
          LIMIT ${query.limit} OFFSET ${query.offset}`,
    );
    return { items: rows.map(mapEdit), total: Number(count?.total ?? 0) };
  }

  async detail(
    projectId: string,
    scope: AsBuiltScope,
    editId: string,
  ): Promise<AsBuiltEditDetail | null> {
    const [row] = await rowsOf<EditRow>(
      this.db,
      sql`SELECT ${EDIT_COLUMNS}
          FROM asbuilt_edits e JOIN users u ON u.id = e.user_id
          WHERE e.project_id = ${projectId} AND e.id = ${editId}
            AND ${editReadScope(projectId, scope)}`,
    );
    if (!row) return null;
    const edit = mapEdit(row);

    const [revision] = await rowsOf<{ crs_epsg: number }>(
      this.db,
      sql`SELECT crs_epsg FROM design_revisions
          WHERE project_id = ${projectId} AND id = ${edit.designRevisionId}`,
    );
    const [designRow] = await rowsOf<{
      code: string | null;
      layer: string;
      geojson: string;
      length_m: string | null;
    }>(
      this.db,
      sql`SELECT df.code, df.layer, ST_AsGeoJSON(df.geom, 3) AS geojson, df.length_m::text AS length_m
          FROM design_features df
          WHERE df.project_id = ${projectId} AND df.revision_id = ${edit.designRevisionId}
            AND df.feature_id = ${edit.featureId}`,
    );

    const latest = await this.latestRevisionId(projectId);
    const [stateRow] = await rowsOf<StateRow>(
      this.db,
      stateQuery(projectId, latest, { kind: 'project' }, edit.featureId),
    );
    const [versions] = await rowsOf<{ geometry_version: number; label_version: number }>(
      this.db,
      sql`SELECT geometry_version, label_version FROM asbuilt_features
          WHERE project_id = ${projectId} AND feature_id = ${edit.featureId}`,
    );
    const current = {
      geometryVersion: versions?.geometry_version ?? 0,
      labelVersion: versions?.label_version ?? 0,
    };

    return {
      edit,
      crsEpsg: revision?.crs_epsg ?? 0,
      design: designRow
        ? {
            revisionId: edit.designRevisionId,
            code: designRow.code,
            layer: designRow.layer,
            geometry: parseGeometry(designRow.geojson),
            lengthM: toDecimalTextOrNull(designRow.length_m),
          }
        : null,
      current: stateRow ? mapState(stateRow) : null,
      approvable: edit.status === 'pending' && isBaseCurrent(edit.kind, edit.baseVersion, current),
    };
  }

  async state(projectId: string, scope: AsBuiltScope): Promise<AsBuiltStateResponse | null> {
    const [project] = await rowsOf<{ crs_epsg: number }>(
      this.db,
      sql`SELECT crs_epsg FROM projects WHERE id = ${projectId}`,
    );
    if (!project) return null;
    const revisionId = await this.latestRevisionId(projectId);
    return {
      revisionId,
      crsEpsg: project.crs_epsg,
      features: await this.stateInScope(projectId, scope, revisionId),
    };
  }

  async stateInScope(
    projectId: string,
    scope: AsBuiltScope,
    knownLatest?: string | null,
  ): Promise<AsBuiltFeatureState[]> {
    const latest = knownLatest === undefined ? await this.latestRevisionId(projectId) : knownLatest;
    const rows = await rowsOf<StateRow>(this.db, stateQuery(projectId, latest, scope));
    return rows.map(mapState);
  }

  async editsAfter(
    projectId: string,
    scope: AsBuiltScope,
    cursor: string,
    limit: number,
  ): Promise<{ seq: string; edit: AsBuiltEdit }[]> {
    const rows = await rowsOf<EditRow>(
      this.db,
      sql`SELECT ${EDIT_COLUMNS}
          FROM asbuilt_edits e JOIN users u ON u.id = e.user_id
          WHERE e.project_id = ${projectId} AND e.sync_seq > ${cursor}::bigint
            AND ${editReadScope(projectId, scope)}
          ORDER BY e.sync_seq
          LIMIT ${limit}`,
    );
    return rows.map((row) => ({ seq: row.sync_seq, edit: mapEdit(row) }));
  }

  async routeLengths(
    projectId: string,
    scope: AsBuiltScope = { kind: 'project' },
  ): Promise<AsBuiltLengthsResponse> {
    const revisionId = await this.latestRevisionId(projectId);
    if (!revisionId) return { revisionId: null, routes: [] };
    const rows = await rowsOf<{
      feature_id: string;
      code: string | null;
      added: boolean;
      design_length_m: string | null;
      length_m: string;
      has_asbuilt: boolean;
      geometry_version: number;
    }>(
      this.db,
      sql`
        SELECT df.feature_id, df.code, false AS added, df.length_m::text AS design_length_m,
               COALESCE(a.length_m, df.length_m)::text AS length_m,
               (a.geom IS NOT NULL) AS has_asbuilt,
               COALESCE(a.geometry_version, 0) AS geometry_version
        FROM design_features df
        LEFT JOIN asbuilt_features a
          ON a.project_id = df.project_id AND a.feature_id = df.feature_id
        WHERE df.project_id = ${projectId} AND df.revision_id = ${revisionId}
          AND df.feature_type = 'route'
          AND ${stateScope(scope)}
        UNION ALL
        SELECT a.feature_id, NULL, true, NULL, a.length_m::text, true, a.geometry_version
        FROM asbuilt_features a
        LEFT JOIN design_features df ON false
        WHERE a.project_id = ${projectId} AND a.added AND a.feature_type = 'route'
          AND ${stateScope(scope)}
        ORDER BY 2 NULLS LAST, 1`,
    );
    const routes: AsBuiltRouteLength[] = rows.map((row) => ({
      featureId: row.feature_id,
      code: row.code,
      added: row.added,
      designLengthM: toDecimalTextOrNull(row.design_length_m),
      lengthM: toDecimalText(row.length_m),
      source: row.has_asbuilt ? 'asbuilt' : 'design',
      geometryVersion: row.geometry_version,
    }));
    return { revisionId, routes };
  }
}
