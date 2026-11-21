import {
  AsBuiltGeometrySchema,
  type AsBuiltEdit,
  type AsBuiltEditFlag,
  type AsBuiltFeatureState,
  type AsBuiltGeometry,
} from '@ftth/shared';
import { sql, type SQL } from 'drizzle-orm';
import { toDecimalText, toDecimalTextOrNull } from '../../../common/decimal-text.js';
import { uuidArray } from '../../../db/sql.js';
import type { AsBuiltScope } from '../application/ports.js';

export const iso = (value: Date | string): string => new Date(value).toISOString();

/** GeoJSON text from PostGIS (3 decimals = millimetres) → the contract geometry (x, y only). */
export function parseGeometry(geojson: string): AsBuiltGeometry {
  const parsed = JSON.parse(geojson) as {
    type: 'Point' | 'LineString';
    coordinates: number[] | number[][];
  };
  if (parsed.type === 'Point') {
    const [x = 0, y = 0] = parsed.coordinates as number[];
    return AsBuiltGeometrySchema.parse({ type: 'Point', coordinates: [x, y] });
  }
  // Rows come from our own tables; shape is guaranteed by CHECK constraints.
  return {
    type: 'LineString',
    coordinates: (parsed.coordinates as number[][]).map(
      ([x = 0, y = 0]) => [x, y] as [number, number],
    ),
  };
}

/**
 * The latest published revision of EACH General drawing of the project (ADR-049 part B), as a
 * subquery of ids to use after `IN (…)` (project id bound). Feature ids are stable within a
 * drawing, so a feature is found in exactly one of them.
 */
export const latestRevisionIdsSql = (projectId: string): SQL =>
  sql`SELECT DISTINCT ON (r.drawing_id) r.id FROM design_revisions r
        WHERE r.project_id = ${projectId} AND r.status = 'published'
          AND r.drawing_kind = 'general'
        ORDER BY r.drawing_id, r.rev_no DESC`;

/**
 * True when the feature of row `alias` (asbuilt_edits `e` or asbuilt_features `a`) belongs to one
 * of the caller's sites (ADR-054): a design feature through the drawing of a revision it is drawn
 * in; an added feature through the drawing of the revision its add edit was recorded on. Nothing
 * else links a feature to a site, so anything unlinked is out of scope (fail closed).
 */
function featureInSites(alias: SQL, scope: { siteIds: readonly string[] }): SQL {
  return sql`(
    EXISTS (
      SELECT 1 FROM design_features sf
      JOIN design_revisions sr ON sr.project_id = sf.project_id AND sr.id = sf.revision_id
      JOIN site_drawings sd ON sd.project_id = sr.project_id AND sd.id = sr.drawing_id
      WHERE sf.project_id = ${alias}.project_id AND sf.feature_id = ${alias}.feature_id
        AND sd.site_id = ANY(${uuidArray(scope.siteIds)}))
    OR EXISTS (
      SELECT 1 FROM asbuilt_edits sa
      JOIN design_revisions sr ON sr.project_id = sa.project_id AND sr.id = sa.design_revision_id
      JOIN site_drawings sd ON sd.project_id = sr.project_id AND sd.id = sr.drawing_id
      WHERE sa.project_id = ${alias}.project_id AND sa.feature_id = ${alias}.feature_id
        AND sa.kind IN ('add_route', 'add_symbol')
        AND sd.site_id = ANY(${uuidArray(scope.siteIds)})))`;
}

/**
 * Read scope of an edit, alias `e` (asbuilt_edits). ADR-054: the edit's feature belongs to one of
 * the caller's sites (see `featureInSites`); a supervisor without sites sees nothing.
 */
export function editReadScope(_projectId: string, scope: AsBuiltScope): SQL {
  if (scope.kind === 'project') return sql`true`;
  if (scope.siteIds.length === 0) return sql`false`;
  return featureInSites(sql.raw('e'), scope);
}

/**
 * Scope of an approved-state row: alias `a` (asbuilt_features), or `df` for a design feature that
 * may have no As-Built row yet; same rule as the edits.
 */
export function stateScope(scope: AsBuiltScope, alias: 'a' | 'df' = 'a'): SQL {
  if (scope.kind === 'project') return sql`true`;
  if (scope.siteIds.length === 0) return sql`false`;
  return featureInSites(sql.raw(alias), scope);
}

/** Columns of an edit as the contract returns it; alias `e`, joined users `u`. */
export const EDIT_COLUMNS = sql`
  e.id, e.client_op_id, e.feature_id, e.kind, e.feature_type, e.design_revision_id,
  e.base_version,
  CASE WHEN e.geom IS NULL THEN NULL ELSE ST_AsGeoJSON(e.geom, 3) END AS geojson,
  e.label, e.length_m::text AS length_m, e.note, e.user_id, u.display_name AS user_name,
  e.device_id, e.captured_at, e.received_at, e.flags, e.status, e.review_reason,
  e.reviewed_by, e.reviewed_at, e.approved_version, e.sync_seq::text AS sync_seq`;

export interface EditRow {
  id: string;
  client_op_id: string;
  feature_id: string;
  kind: AsBuiltEdit['kind'];
  feature_type: AsBuiltEdit['featureType'];
  design_revision_id: string;
  base_version: number | null;
  geojson: string | null;
  label: string | null;
  length_m: string | null;
  note: string | null;
  user_id: string;
  user_name: string;
  device_id: string;
  captured_at: Date;
  received_at: Date;
  flags: AsBuiltEditFlag[];
  status: AsBuiltEdit['status'];
  review_reason: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  approved_version: number | null;
  sync_seq: string;
}

export function mapEdit(row: EditRow): AsBuiltEdit {
  return {
    id: row.id,
    clientOpId: row.client_op_id,
    featureId: row.feature_id,
    kind: row.kind,
    featureType: row.feature_type,
    designRevisionId: row.design_revision_id,
    baseVersion: row.base_version,
    geometry: row.geojson === null ? null : parseGeometry(row.geojson),
    label: row.label,
    lengthM: toDecimalTextOrNull(row.length_m),
    note: row.note,
    userId: row.user_id,
    userName: row.user_name,
    deviceId: row.device_id,
    capturedAt: iso(row.captured_at),
    receivedAt: iso(row.received_at),
    flags: row.flags,
    status: row.status,
    reviewReason: row.review_reason,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at ? iso(row.reviewed_at) : null,
    approvedVersion: row.approved_version,
  };
}

export interface StateRow {
  feature_id: string;
  feature_type: AsBuiltFeatureState['featureType'];
  added: boolean;
  geojson: string;
  length_m: string | null;
  label: string | null;
  geometry_version: number;
  label_version: number;
}

/**
 * Approved state rows of a project: the approved geometry, or the design geometry of the latest
 * published revisions (one per General drawing) when only a label was approved (a feature missing from that revision has no
 * geometry to show and is left out). Optional `featureId` narrows to one feature.
 */
export function stateQuery(
  projectId: string,
  latestRevisionIds: readonly string[],
  scope: AsBuiltScope,
  featureId?: string,
): SQL {
  return sql`
    SELECT a.feature_id, a.feature_type, a.added,
           ST_AsGeoJSON(COALESCE(a.geom, df.geom), 3) AS geojson,
           CASE WHEN a.feature_type = 'route' THEN COALESCE(a.length_m, df.length_m)::text END AS length_m,
           a.label, a.geometry_version, a.label_version
    FROM asbuilt_features a
    LEFT JOIN design_features df
      ON df.project_id = a.project_id AND df.feature_id = a.feature_id
     AND df.revision_id = ANY(${uuidArray(latestRevisionIds)})
    WHERE a.project_id = ${projectId}
      AND COALESCE(a.geom, df.geom) IS NOT NULL
      AND ${featureId ? sql`a.feature_id = ${featureId}` : sql`true`}
      AND ${stateScope(scope)}
    ORDER BY a.feature_id`;
}

export function mapState(row: StateRow): AsBuiltFeatureState {
  return {
    featureId: row.feature_id,
    featureType: row.feature_type,
    added: row.added,
    geometry: parseGeometry(row.geojson),
    lengthM: row.length_m === null ? null : toDecimalText(row.length_m),
    label: row.label,
    geometryVersion: row.geometry_version,
    labelVersion: row.label_version,
  };
}
