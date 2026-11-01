import type { AsBuiltEdit, AsBuiltGeometry, OpResult } from '@ftth/shared';
import { toDecimalTextOrNull } from '../../../common/decimal-text.js';
import type { ApprovedVersions } from '../../asbuilt/domain/review.js';
import { lockProjectForSync } from '../../../common/project-sync-lock.js';
import { sql, type SQL } from 'drizzle-orm';
import type { Database, DbHandle } from '../../../db/db.module.js';
import { DrizzleEventLog } from '../../../db/drizzle-event-log.js';
import { rowsOf, uuidArray } from '../../../db/sql.js';
import type { DomainEventInput } from '../../../common/event-log.port.js';
import type {
  ExecutionScope,
  ExecutionTx,
  ExecutionUnitOfWork,
  FeatureInRevision,
  ItemFacts,
  LatestRevision,
  NewAsBuiltEdit,
  NewUpdate,
  StoredOperation,
} from '../application/ports.js';

export { rowsOf, uuidArray };

/**
 * True for features whose design geometry in the given revision intersects one of the caller's
 * zones. Until Phase 2 assigns features to zones the zone polygon is the only source (ADR-024);
 * a zone without geometry contains nothing.
 */
export function zoneCondition(
  projectId: string,
  revisionColumn: SQL,
  featureColumn: SQL,
  scope: ExecutionScope,
): SQL {
  if (scope.kind === 'project') return sql`true`;
  if (scope.zoneIds.length === 0) return sql`false`;
  return sql`EXISTS (
    SELECT 1 FROM design_features zdf
    JOIN zones z ON z.project_id = zdf.project_id
    WHERE zdf.project_id = ${projectId}
      AND zdf.revision_id = ${revisionColumn}
      AND zdf.feature_id = ${featureColumn}
      AND z.id = ANY(${uuidArray(scope.zoneIds)})
      AND z.geom IS NOT NULL
      AND ST_Intersects(z.geom, zdf.geom))`;
}

/** text[] of enum constants (no commas by construction); empty list → '{}'. */
function enumArray(values: readonly string[]): SQL {
  return sql`string_to_array(${values.join(',')}, ',')::text[]`;
}

export class DrizzleExecutionTx implements ExecutionTx {
  private readonly events: DrizzleEventLog;

  constructor(
    private readonly db: DbHandle,
    private readonly lockTimeoutMs: number,
  ) {
    this.events = new DrizzleEventLog(db);
  }

  async lockProject(projectId: string): Promise<void> {
    await lockProjectForSync(this.db, projectId, this.lockTimeoutMs);
  }

  async findOperation(clientOpId: string): Promise<StoredOperation | null> {
    const [row] = await rowsOf<{
      project_id: string;
      user_id: string;
      device_id: string;
      payload_sha256: string;
      result: OpResult;
    }>(
      this.db,
      sql`SELECT project_id, user_id, device_id, payload_sha256, result
          FROM sync_operations WHERE client_op_id = ${clientOpId}`,
    );
    return row
      ? {
          projectId: row.project_id,
          userId: row.user_id,
          deviceId: row.device_id,
          payloadSha256: row.payload_sha256,
          result: row.result,
        }
      : null;
  }

  async insertOperation(input: {
    clientOpId: string;
    projectId: string;
    userId: string;
    deviceId: string;
    kind: string;
    payloadSha256: string;
    result: OpResult;
    receivedAt: Date;
  }): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO sync_operations
        (client_op_id, project_id, user_id, device_id, kind, payload_sha256, result, received_at)
      VALUES (${input.clientOpId}, ${input.projectId}, ${input.userId}, ${input.deviceId},
              ${input.kind}, ${input.payloadSha256}, ${JSON.stringify(input.result)}::jsonb,
              ${input.receivedAt.toISOString()})`);
  }

  async featureExists(projectId: string, featureId: string): Promise<boolean> {
    const rows = await rowsOf(
      this.db,
      sql`SELECT 1 FROM features WHERE project_id = ${projectId} AND id = ${featureId}`,
    );
    return rows.length > 0;
  }

  async featureInPublishedRevision(
    projectId: string,
    revisionId: string,
    featureId: string,
  ): Promise<FeatureInRevision | null> {
    const [row] = await rowsOf<{
      feature_type: FeatureInRevision['featureType'];
      published_at: Date;
    }>(
      this.db,
      sql`SELECT df.feature_type, r.published_at
          FROM design_features df
          JOIN design_revisions r ON r.project_id = df.project_id AND r.id = df.revision_id
          WHERE df.project_id = ${projectId} AND df.revision_id = ${revisionId}
            AND df.feature_id = ${featureId} AND r.status = 'published'`,
    );
    return row
      ? { featureType: row.feature_type, revisionPublishedAt: new Date(row.published_at) }
      : null;
  }

  async featureInScope(
    projectId: string,
    revisionId: string,
    featureId: string,
    scope: ExecutionScope,
  ): Promise<boolean> {
    const [row] = await rowsOf<{ ok: boolean }>(
      this.db,
      sql`SELECT ${zoneCondition(projectId, sql`${revisionId}::uuid`, sql`${featureId}::uuid`, scope)} AS ok`,
    );
    return row?.ok === true;
  }

  async latestPublishedRevision(projectId: string): Promise<LatestRevision | null> {
    return latestPublished(this.db, projectId);
  }

  async featureInRevision(
    projectId: string,
    revisionId: string,
    featureId: string,
  ): Promise<boolean> {
    const rows = await rowsOf(
      this.db,
      sql`SELECT 1 FROM design_features
          WHERE project_id = ${projectId} AND revision_id = ${revisionId} AND feature_id = ${featureId}`,
    );
    return rows.length > 0;
  }

  async findItems(projectId: string, itemIds: readonly string[]): Promise<ItemFacts[]> {
    const rows = await rowsOf<{ id: string; work_type: ItemFacts['workType'] }>(
      this.db,
      sql`SELECT id, work_type FROM work_order_items
          WHERE project_id = ${projectId} AND id = ANY(${uuidArray(itemIds)})`,
    );
    return rows.map((row) => ({ id: row.id, workType: row.work_type }));
  }

  async wouldOverrun(
    projectId: string,
    lines: readonly { workOrderItemId: string; quantity: string }[],
  ): Promise<boolean> {
    // Exact numeric arithmetic in PostgreSQL; quantities never pass through a float.
    const incoming = sql.join(
      lines.map((line) => sql`(${line.workOrderItemId}::uuid, ${line.quantity}::numeric)`),
      sql`, `,
    );
    const [row] = await rowsOf<{ overrun: boolean }>(
      this.db,
      sql`WITH incoming(item_id, qty) AS (VALUES ${incoming}),
               adding AS (SELECT item_id, sum(qty) AS qty FROM incoming GROUP BY item_id)
          SELECT EXISTS (
            SELECT 1 FROM adding a
            JOIN work_order_items i ON i.project_id = ${projectId} AND i.id = a.item_id
            WHERE a.qty + COALESCE((
              SELECT sum(l.quantity) FROM execution_update_lines l
              JOIN execution_updates u ON u.project_id = l.project_id AND u.id = l.update_id
              WHERE l.project_id = ${projectId} AND l.work_order_item_id = a.item_id
                AND u.status <> 'rejected'), 0) > i.quantity
          ) AS overrun`,
    );
    return row?.overrun === true;
  }

  async gpsDistanceM(
    projectId: string,
    revisionId: string,
    featureId: string,
    gps: { lon: number; lat: number },
  ): Promise<number> {
    const [row] = await rowsOf<{ d: string }>(
      this.db,
      sql`SELECT round(ST_Distance(
                ST_Transform(ST_SetSRID(ST_MakePoint(${gps.lon}, ${gps.lat}), 4326), ST_SRID(df.geom)),
                df.geom)::numeric, 3)::text AS d
          FROM design_features df
          WHERE df.project_id = ${projectId} AND df.revision_id = ${revisionId}
            AND df.feature_id = ${featureId}`,
    );
    if (!row) throw new Error('feature disappeared inside the transaction');
    return Number(row.d);
  }

  async anyPhotoExists(photoIds: readonly string[]): Promise<boolean> {
    const rows = await rowsOf(
      this.db,
      sql`SELECT 1 FROM execution_photos WHERE id = ANY(${uuidArray(photoIds)}) LIMIT 1`,
    );
    return rows.length > 0;
  }

  async insertUpdate(update: NewUpdate): Promise<void> {
    const gps = update.gps;
    const gpsPoint = gps
      ? sql`ST_SetSRID(ST_MakePoint(${gps.lon}, ${gps.lat}), 4326)`
      : sql`NULL::geometry`;
    await this.db.execute(sql`
      INSERT INTO execution_updates (
        id, project_id, client_op_id, feature_id, feature_type, design_revision_id, work_type,
        user_id, device_id, captured_at, received_at, label, note,
        gps_wgs84, gps_accuracy_m, gps_at, gps_geom, gps_distance_m,
        flags, acknowledged_warnings)
      SELECT ${update.id}, ${update.projectId}, ${update.clientOpId}, ${update.featureId},
             ${update.featureType}, ${update.designRevisionId}, ${update.workType},
             ${update.userId}, ${update.deviceId}, ${update.capturedAt.toISOString()},
             ${update.receivedAt.toISOString()}, ${update.label}, ${update.note},
             ${gpsPoint}, ${gps?.accuracyM ?? null}, ${gps ? gps.at.toISOString() : null},
             CASE WHEN ${gps !== null} THEN ST_Transform(${gpsPoint}, ST_SRID(df.geom)) END,
             CASE WHEN ${gps !== null}
               THEN round(ST_Distance(ST_Transform(${gpsPoint}, ST_SRID(df.geom)), df.geom)::numeric, 3)
             END,
             ${enumArray(update.flags)},
             ${enumArray(update.acknowledgedWarnings)}
      FROM design_features df
      WHERE df.project_id = ${update.projectId} AND df.revision_id = ${update.designRevisionId}
        AND df.feature_id = ${update.featureId}`);
    for (const [index, line] of update.lines.entries()) {
      await this.db.execute(sql`
        INSERT INTO execution_update_lines
          (update_id, project_id, line_no, role, work_order_item_id, quantity)
        VALUES (${update.id}, ${update.projectId}, ${index + 1}, ${line.role},
                ${line.workOrderItemId}, ${line.quantity}::numeric)`);
    }
    for (const photo of update.photos) {
      await this.db.execute(sql`
        INSERT INTO execution_photos
          (id, project_id, update_id, requirement_key, sha256, size_bytes, content_type, taken_at,
           gps_wgs84, gps_accuracy_m)
        VALUES (${photo.photoId}, ${update.projectId}, ${update.id}, ${photo.requirementKey},
                ${photo.sha256}, ${photo.sizeBytes}, 'image/jpeg', ${photo.takenAt.toISOString()},
                ${photo.gps ? sql`ST_SetSRID(ST_MakePoint(${photo.gps.lon}, ${photo.gps.lat}), 4326)` : sql`NULL`},
                ${photo.gps?.accuracyM ?? null})`);
    }
  }

  async appendEvent(event: DomainEventInput): Promise<void> {
    await this.events.append(event);
  }

  // ---- As-Built edits (Phase 4, ADR-030) -------------------------------------------------

  async publishedRevision(
    projectId: string,
    revisionId: string,
  ): Promise<{ publishedAt: Date; crsEpsg: number } | null> {
    const [row] = await rowsOf<{ published_at: Date; crs_epsg: number }>(
      this.db,
      sql`SELECT published_at, crs_epsg FROM design_revisions
          WHERE project_id = ${projectId} AND id = ${revisionId} AND status = 'published'`,
    );
    return row ? { publishedAt: new Date(row.published_at), crsEpsg: row.crs_epsg } : null;
  }

  async featureIdTaken(featureId: string): Promise<boolean> {
    // `features.id` and the one-add-per-id index are global, so the check is too.
    const rows = await rowsOf(
      this.db,
      sql`SELECT 1 FROM features WHERE id = ${featureId}
          UNION ALL
          SELECT 1 FROM asbuilt_edits WHERE feature_id = ${featureId}
            AND kind IN ('add_route', 'add_symbol')
          LIMIT 1`,
    );
    return rows.length > 0;
  }

  async asBuiltTarget(
    projectId: string,
    featureId: string,
  ): Promise<{ featureType: AsBuiltEdit['featureType']; origin: 'design' | 'added' } | null> {
    const [row] = await rowsOf<{
      feature_type: AsBuiltEdit['featureType'];
      origin: 'design' | 'added';
    }>(
      this.db,
      sql`SELECT feature_type, 'design' AS origin FROM features
            WHERE project_id = ${projectId} AND id = ${featureId}
          UNION ALL
          SELECT feature_type, 'added' AS origin FROM asbuilt_features
            WHERE project_id = ${projectId} AND feature_id = ${featureId} AND added
          LIMIT 1`,
    );
    return row ? { featureType: row.feature_type, origin: row.origin } : null;
  }

  async geometryFacts(
    srid: number,
    geometry: AsBuiltGeometry,
  ): Promise<{ valid: boolean; lengthM: number }> {
    const [row] = await rowsOf<{ valid: boolean; length_m: number }>(
      this.db,
      sql`SELECT ST_IsValid(g) AS valid, ST_Length(g) AS length_m
          FROM (SELECT ${projectGeometry(geometry, srid)} AS g) s`,
    );
    return { valid: row?.valid === true, lengthM: Number(row?.length_m ?? 0) };
  }

  async geometryInScope(
    projectId: string,
    srid: number,
    geometry: AsBuiltGeometry,
    scope: ExecutionScope,
  ): Promise<boolean> {
    if (scope.kind === 'project') return true;
    if (scope.zoneIds.length === 0) return false;
    const [row] = await rowsOf<{ ok: boolean }>(
      this.db,
      // The whole proposed geometry must lie inside the caller's zones (security review M1:
      // touching one zone is not enough, a route could otherwise run on into other zones).
      sql`SELECT coalesce(ST_CoveredBy(${projectGeometry(geometry, srid)}, ST_Union(z.geom)), false) AS ok
          FROM zones z
          WHERE z.project_id = ${projectId} AND z.id = ANY(${uuidArray(scope.zoneIds)})
            AND z.geom IS NOT NULL`,
    );
    return row?.ok === true;
  }

  async addedFeatureInScope(
    projectId: string,
    featureId: string,
    scope: ExecutionScope,
  ): Promise<boolean> {
    if (scope.kind === 'project') return true;
    if (scope.zoneIds.length === 0) return false;
    const [row] = await rowsOf<{ ok: boolean }>(
      this.db,
      sql`SELECT EXISTS (
            SELECT 1 FROM asbuilt_features a
            JOIN zones z ON z.project_id = a.project_id
            WHERE a.project_id = ${projectId} AND a.feature_id = ${featureId} AND a.added
              AND z.id = ANY(${uuidArray(scope.zoneIds)}) AND z.geom IS NOT NULL
              AND ST_Intersects(z.geom, a.geom)) AS ok`,
    );
    return row?.ok === true;
  }

  async approvedVersions(projectId: string, featureId: string): Promise<ApprovedVersions> {
    const [row] = await rowsOf<{ geometry_version: number; label_version: number }>(
      this.db,
      sql`SELECT geometry_version, label_version FROM asbuilt_features
          WHERE project_id = ${projectId} AND feature_id = ${featureId}`,
    );
    return {
      geometryVersion: row?.geometry_version ?? 0,
      labelVersion: row?.label_version ?? 0,
    };
  }

  async insertAsBuiltEdit(edit: NewAsBuiltEdit): Promise<{ lengthM: string | null }> {
    const gps = edit.gps;
    const [row] = await rowsOf<{ length_m: string | null }>(
      this.db,
      sql`INSERT INTO asbuilt_edits (
            id, project_id, client_op_id, feature_id, kind, feature_type, design_revision_id,
            base_version, geom, label, note, user_id, device_id, captured_at, received_at,
            gps_wgs84, gps_accuracy_m, gps_at, flags)
          VALUES (
            ${edit.id}, ${edit.projectId}, ${edit.clientOpId}, ${edit.featureId}, ${edit.kind},
            ${edit.featureType}, ${edit.designRevisionId}, ${edit.baseVersion}::int,
            ${edit.geometry ? projectGeometry(edit.geometry, edit.srid) : sql`NULL::geometry`},
            ${edit.label}, ${edit.note}, ${edit.userId}, ${edit.deviceId},
            ${edit.capturedAt.toISOString()}, ${edit.receivedAt.toISOString()},
            ${gps ? sql`ST_SetSRID(ST_MakePoint(${gps.lon}, ${gps.lat}), 4326)` : sql`NULL::geometry`},
            ${gps?.accuracyM ?? null}::double precision,
            ${gps ? gps.at.toISOString() : null}::timestamptz,
            ${enumArray(edit.flags)})
          RETURNING length_m::text AS length_m`,
    );
    return { lengthM: toDecimalTextOrNull(row?.length_m ?? null) };
  }
}

/** A project-CRS (metres) GeoJSON geometry in the revision's SRID; never transformed. */
function projectGeometry(geometry: AsBuiltGeometry, srid: number): SQL {
  return sql`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify({
    type: geometry.type,
    coordinates: geometry.coordinates,
  })}::text), ${srid}::int)`;
}

export async function latestPublished(
  db: DbHandle,
  projectId: string,
): Promise<LatestRevision | null> {
  const [row] = await rowsOf<{
    id: string;
    rev_no: number;
    published_at: Date;
    tiles_storage_key: string | null;
  }>(
    db,
    sql`SELECT id, rev_no, published_at, tiles_storage_key FROM design_revisions
        WHERE project_id = ${projectId} AND status = 'published'
        ORDER BY rev_no DESC LIMIT 1`,
  );
  return row
    ? {
        id: row.id,
        revNo: row.rev_no,
        publishedAt: new Date(row.published_at),
        hasTiles: row.tiles_storage_key !== null,
      }
    : null;
}

export class DrizzleExecutionUnitOfWork implements ExecutionUnitOfWork {
  constructor(
    private readonly db: Database,
    private readonly lockTimeoutMs: number,
  ) {}

  run<T>(work: (tx: ExecutionTx) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => work(new DrizzleExecutionTx(tx, this.lockTimeoutMs)));
  }
}
