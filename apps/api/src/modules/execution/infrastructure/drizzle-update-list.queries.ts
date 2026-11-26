import type {
  LineDimensions,
  UpdateFlag,
  UpdateListItem,
  UpdateListLine,
  UpdateListQuery,
} from '@ftth/shared';
import { sql, type SQL } from 'drizzle-orm';
import { toDecimalText, toDecimalTextOrNull } from '../../../common/decimal-text.js';
import type { DbHandle } from '../../../db/db.module.js';
import type { ExecutionScope, UpdateListQueries } from '../application/ports.js';
import { rowsOf, uuidArray } from './drizzle-execution.repository.js';

const iso = (value: Date | string): string => new Date(value).toISOString();

/**
 * The drawing an update belongs to: the drawing of a «التخطيط» update (ADR-056), else the drawing
 * of the revision it was recorded on. Its site is the update's site (ADR-054: the same reach as
 * the sync feed, since a recorded element always lies in that revision).
 */
const FROM_UPDATES = sql`FROM execution_updates u
  JOIN design_revisions r ON r.project_id = u.project_id AND r.id = u.design_revision_id
  JOIN site_drawings d ON d.project_id = u.project_id AND d.id = COALESCE(u.drawing_id, r.drawing_id)`;

function inScope(scope: ExecutionScope): SQL {
  if (scope.kind === 'project') return sql`true`;
  if (scope.siteIds.length === 0) return sql`false`;
  return sql`d.site_id = ANY(${uuidArray(scope.siteIds)})`;
}

function filters(projectId: string, scope: ExecutionScope, query: UpdateListQuery): SQL {
  const parts: SQL[] = [sql`u.project_id = ${projectId}`, inScope(scope)];
  if (query.status) parts.push(sql`u.status = ${query.status}`);
  if (query.siteId) parts.push(sql`d.site_id = ${query.siteId}`);
  return sql.join(parts, sql` AND `);
}

interface LineRow {
  role: UpdateListLine['role'];
  workOrderNumber: string;
  itemCode: string;
  itemDescription: string;
  unit: string;
  quantity: string;
  dimensions: LineDimensions | null;
  performer: UpdateListLine['performer'];
}

/** Read side of the web list of recorded updates (ADR-059). Never writes. */
export class DrizzleUpdateListQueries implements UpdateListQueries {
  constructor(private readonly db: DbHandle) {}

  async list(
    projectId: string,
    scope: ExecutionScope,
    query: UpdateListQuery,
  ): Promise<{ items: UpdateListItem[]; total: number }> {
    const where = filters(projectId, scope, query);
    const [count] = await rowsOf<{ total: number }>(
      this.db,
      sql`SELECT count(*)::int AS total ${FROM_UPDATES} WHERE ${where}`,
    );
    const rows = await rowsOf<{
      id: string;
      status: UpdateListItem['status'];
      work_type: UpdateListItem['workType'];
      feature_id: string | null;
      feature_type: UpdateListItem['featureType'];
      feature_code: string | null;
      site_id: string | null;
      site_name: string | null;
      drawing_kind: UpdateListItem['drawingKind'];
      drawing_ordinal: number;
      rev_no: number;
      supervisor_name: string;
      work_date: string | null;
      captured_at: Date;
      received_at: Date;
      lat: number | null;
      lon: number | null;
      gps_accuracy_m: number | null;
      gps_distance_m: string | null;
      flags: UpdateFlag[];
      label: string | null;
      note: string | null;
      review_reason: string | null;
      lines: LineRow[];
      photos: { photoId: string; requirementKey: string; stored: boolean }[];
    }>(
      this.db,
      sql`SELECT u.id, u.status, u.work_type, u.feature_id, u.feature_type,
                 (SELECT df.code FROM design_features df
                  WHERE df.project_id = u.project_id AND df.revision_id = u.design_revision_id
                    AND df.feature_id = u.feature_id) AS feature_code,
                 d.site_id, s.name AS site_name, d.drawing_kind, d.ordinal AS drawing_ordinal,
                 r.rev_no, usr.display_name AS supervisor_name,
                 to_char(u.work_date, 'YYYY-MM-DD') AS work_date, u.captured_at, u.received_at,
                 ST_Y(u.gps_wgs84) AS lat, ST_X(u.gps_wgs84) AS lon, u.gps_accuracy_m,
                 u.gps_distance_m::text AS gps_distance_m, u.flags, u.label, u.note,
                 u.review_reason,
                 (SELECT COALESCE(json_agg(json_build_object(
                     'role', l.role,
                     'workOrderNumber', o.number,
                     'itemCode', i.code,
                     'itemDescription', i.description,
                     'unit', i.unit,
                     'quantity', l.quantity::text,
                     'dimensions', CASE WHEN l.length_m IS NULL THEN NULL ELSE json_build_object(
                       'lengthM', l.length_m::text, 'widthM', l.width_m::text,
                       'depthM', l.depth_m::text) END,
                     'performer', CASE l.performer
                       WHEN 'contractor' THEN json_build_object(
                         'kind', 'contractor', 'contractorName', c.name, 'scope', cl.scope)
                       WHEN 'self' THEN json_build_object('kind', 'self')
                     END) ORDER BY l.line_no), '[]')
                  FROM execution_update_lines l
                  JOIN work_order_items i ON i.project_id = l.project_id AND i.id = l.work_order_item_id
                  JOIN work_orders o ON o.project_id = i.project_id AND o.id = i.work_order_id
                  LEFT JOIN contractor_lines cl ON cl.id = l.contractor_line_id
                  LEFT JOIN contractor_registrations cr
                    ON cr.project_id = cl.project_id AND cr.id = cl.registration_id
                  LEFT JOIN contractors c ON c.id = cr.contractor_id
                  WHERE l.project_id = u.project_id AND l.update_id = u.id) AS lines,
                 (SELECT COALESCE(json_agg(json_build_object(
                     'photoId', p.id,
                     'requirementKey', p.requirement_key,
                     'stored', p.stored_at IS NOT NULL) ORDER BY p.taken_at, p.id), '[]')
                  FROM execution_photos p
                  WHERE p.project_id = u.project_id AND p.update_id = u.id) AS photos
          ${FROM_UPDATES}
          LEFT JOIN work_order_sites s ON s.project_id = d.project_id AND s.id = d.site_id
          JOIN users usr ON usr.id = u.user_id
          WHERE ${where}
          ORDER BY u.received_at DESC, u.id
          LIMIT ${query.limit} OFFSET ${query.offset}`,
    );
    const items = rows.map((row): UpdateListItem => ({
      id: row.id,
      status: row.status,
      workType: row.work_type,
      featureId: row.feature_id,
      featureType: row.feature_type,
      featureCode: row.feature_code,
      siteId: row.site_id,
      siteName: row.site_name,
      drawingKind: row.drawing_kind,
      drawingOrdinal: row.drawing_ordinal,
      revNo: row.rev_no,
      supervisorName: row.supervisor_name,
      workDate: row.work_date,
      capturedAt: iso(row.captured_at),
      receivedAt: iso(row.received_at),
      gps:
        row.lat === null || row.lon === null
          ? null
          : { lat: row.lat, lon: row.lon, accuracyM: row.gps_accuracy_m },
      gpsDistanceM: toDecimalTextOrNull(row.gps_distance_m),
      flags: row.flags,
      label: row.label,
      note: row.note,
      reviewReason: row.review_reason,
      lines: row.lines.map((line) => ({
        ...line,
        quantity: toDecimalText(line.quantity),
        dimensions: line.dimensions
          ? {
              lengthM: toDecimalText(line.dimensions.lengthM),
              widthM: toDecimalText(line.dimensions.widthM),
              depthM: toDecimalText(line.dimensions.depthM),
            }
          : null,
      })),
      photos: row.photos,
    }));
    return { items, total: count?.total ?? 0 };
  }

  async sites(projectId: string, scope: ExecutionScope): Promise<{ id: string; name: string }[]> {
    return rowsOf<{ id: string; name: string }>(
      this.db,
      sql`SELECT DISTINCT s.id, s.name
          ${FROM_UPDATES}
          JOIN work_order_sites s ON s.project_id = d.project_id AND s.id = d.site_id
          WHERE u.project_id = ${projectId} AND ${inScope(scope)}
          ORDER BY s.name, s.id`,
    );
  }

  async photoKey(
    projectId: string,
    scope: ExecutionScope,
    photoId: string,
  ): Promise<string | null> {
    const [row] = await rowsOf<{ storage_key: string }>(
      this.db,
      sql`SELECT p.storage_key
          FROM execution_photos p
          JOIN execution_updates u ON u.project_id = p.project_id AND u.id = p.update_id
          JOIN design_revisions r ON r.project_id = u.project_id AND r.id = u.design_revision_id
          JOIN site_drawings d
            ON d.project_id = u.project_id AND d.id = COALESCE(u.drawing_id, r.drawing_id)
          WHERE p.project_id = ${projectId} AND p.id = ${photoId}
            AND p.stored_at IS NOT NULL AND ${inScope(scope)}`,
    );
    return row?.storage_key ?? null;
  }
}
