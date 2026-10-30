import type {
  CatalogItem,
  ExecutionUpdate,
  OfflineFeature,
  OfflineFeatureGeometry,
  UpdateFlag,
} from '@ftth/shared';
import { sql } from 'drizzle-orm';
import { toDecimalText, toDecimalTextOrNull } from '../../../common/decimal-text.js';
import type { DbHandle } from '../../../db/db.module.js';
import type { ExecutionReadQueries, ExecutionScope, LatestRevision } from '../application/ports.js';
import { latestPublished, rowsOf, zoneCondition } from './drizzle-execution.repository.js';

const iso = (value: Date | string): string => new Date(value).toISOString();

/** Read side of the sync endpoints. Every query is bound to `project_id` and the caller's scope. */
export class DrizzleExecutionReadQueries implements ExecutionReadQueries {
  constructor(private readonly db: DbHandle) {}

  async projectInfo(
    projectId: string,
  ): Promise<{ id: string; name: string; crsEpsg: number } | null> {
    const [row] = await rowsOf<{ id: string; name: string; crs_epsg: number }>(
      this.db,
      sql`SELECT id, name, crs_epsg FROM projects WHERE id = ${projectId}`,
    );
    return row ? { id: row.id, name: row.name, crsEpsg: row.crs_epsg } : null;
  }

  latestPublishedRevision(projectId: string): Promise<LatestRevision | null> {
    return latestPublished(this.db, projectId);
  }

  async featuresInScope(
    projectId: string,
    revisionId: string,
    scope: ExecutionScope,
  ): Promise<OfflineFeature[]> {
    // Coordinates leave the database in the revision CRS (metres), 3 decimals = millimetres.
    const rows = await rowsOf<{
      feature_id: string;
      feature_type: OfflineFeature['type'];
      code: string | null;
      layer: string;
      geojson: string;
      length_m: string | null;
    }>(
      this.db,
      sql`SELECT df.feature_id, df.feature_type, df.code, df.layer,
                 ST_AsGeoJSON(df.geom, 3) AS geojson, df.length_m::text AS length_m
          FROM design_features df
          WHERE df.project_id = ${projectId} AND df.revision_id = ${revisionId}
            AND ${zoneCondition(projectId, sql`df.revision_id`, sql`df.feature_id`, scope)}
          ORDER BY df.feature_type, df.code NULLS LAST, df.feature_id`,
    );
    return rows.map((row) => {
      const parsed = JSON.parse(row.geojson) as OfflineFeatureGeometry;
      const geometry: OfflineFeatureGeometry =
        parsed.type === 'Point'
          ? { type: 'Point', coordinates: [parsed.coordinates[0], parsed.coordinates[1]] }
          : { type: 'LineString', coordinates: parsed.coordinates.map(([x, y]) => [x, y]) };
      return {
        id: row.feature_id,
        type: row.feature_type,
        code: row.code,
        layer: row.layer,
        geometry,
        lengthM: toDecimalTextOrNull(row.length_m),
      };
    });
  }

  async catalog(projectId: string): Promise<CatalogItem[]> {
    const rows = await rowsOf<{
      id: string;
      work_order_id: string;
      number: string;
      line_no: number;
      code: string;
      description: string;
      unit: string;
      quantity: string;
      work_type: CatalogItem['workType'];
      recorded: string;
    }>(
      this.db,
      sql`SELECT i.id, i.work_order_id, o.number, i.line_no, i.code, i.description, i.unit,
                 i.quantity::text AS quantity, i.work_type,
                 COALESCE((
                   SELECT sum(l.quantity) FROM execution_update_lines l
                   JOIN execution_updates u ON u.project_id = l.project_id AND u.id = l.update_id
                   WHERE l.project_id = i.project_id AND l.work_order_item_id = i.id
                     AND u.status <> 'rejected'), 0)::text AS recorded
          FROM work_order_items i
          JOIN work_orders o ON o.project_id = i.project_id AND o.id = i.work_order_id
          WHERE i.project_id = ${projectId}
          ORDER BY o.number, i.line_no`,
    );
    return rows.map((row) => ({
      id: row.id,
      workOrderId: row.work_order_id,
      workOrderNumber: row.number,
      lineNo: row.line_no,
      code: row.code,
      description: row.description,
      unit: row.unit,
      quantity: toDecimalText(row.quantity),
      workType: row.work_type,
      recordedQuantity: toDecimalText(row.recorded),
    }));
  }

  async changes(
    projectId: string,
    scope: ExecutionScope,
    cursor: string,
    limit: number,
  ): Promise<{ updates: ExecutionUpdate[]; seqs: string[] }> {
    const rows = await rowsOf<{
      id: string;
      client_op_id: string;
      feature_id: string;
      feature_type: ExecutionUpdate['featureType'];
      design_revision_id: string;
      user_id: string;
      device_id: string;
      work_type: ExecutionUpdate['workType'];
      status: ExecutionUpdate['status'];
      label: string | null;
      note: string | null;
      captured_at: Date;
      received_at: Date;
      gps_distance_m: string | null;
      flags: UpdateFlag[];
      review_reason: string | null;
      sync_seq: string;
      lines: { workOrderItemId: string; quantity: string; role: 'work' | 'material' }[];
      photos: { photoId: string; requirementKey: string; sizeBytes: number; stored: boolean }[];
    }>(
      this.db,
      sql`SELECT u.id, u.client_op_id, u.feature_id, u.feature_type, u.design_revision_id,
                 u.user_id, u.device_id, u.work_type, u.status, u.label, u.note, u.captured_at,
                 u.received_at, u.gps_distance_m::text AS gps_distance_m, u.flags,
                 u.review_reason, u.sync_seq::text AS sync_seq,
                 (SELECT COALESCE(json_agg(json_build_object(
                     'workOrderItemId', l.work_order_item_id,
                     'quantity', l.quantity::text,
                     'role', l.role) ORDER BY l.line_no), '[]')
                  FROM execution_update_lines l WHERE l.update_id = u.id) AS lines,
                 (SELECT COALESCE(json_agg(json_build_object(
                     'photoId', p.id,
                     'requirementKey', p.requirement_key,
                     'sizeBytes', p.size_bytes,
                     'stored', p.stored_at IS NOT NULL) ORDER BY p.taken_at, p.id), '[]')
                  FROM execution_photos p WHERE p.update_id = u.id) AS photos
          FROM execution_updates u
          WHERE u.project_id = ${projectId} AND u.sync_seq > ${cursor}::bigint
            AND ${zoneCondition(projectId, sql`u.design_revision_id`, sql`u.feature_id`, scope)}
          ORDER BY u.sync_seq
          LIMIT ${limit}`,
    );
    return {
      seqs: rows.map((row) => row.sync_seq),
      updates: rows.map((row) => ({
        id: row.id,
        clientOpId: row.client_op_id,
        featureId: row.feature_id,
        featureType: row.feature_type,
        designRevisionId: row.design_revision_id,
        userId: row.user_id,
        deviceId: row.device_id,
        workType: row.work_type,
        status: row.status,
        lines: row.lines.map((line) => ({ ...line, quantity: toDecimalText(line.quantity) })),
        label: row.label,
        note: row.note,
        capturedAt: iso(row.captured_at),
        receivedAt: iso(row.received_at),
        gpsDistanceM: toDecimalTextOrNull(row.gps_distance_m),
        flags: row.flags,
        reviewReason: row.review_reason,
        photos: row.photos,
      })),
    };
  }
}
