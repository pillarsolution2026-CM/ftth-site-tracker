import type { OpResult } from '@ftth/shared';
import { sql, type SQL } from 'drizzle-orm';
import type { Database, DbHandle } from '../../../db/db.module.js';
import { DrizzleEventLog } from '../../../db/drizzle-event-log.js';
import type { DomainEventInput } from '../../../common/event-log.port.js';
import type {
  ExecutionScope,
  ExecutionTx,
  ExecutionUnitOfWork,
  FeatureInRevision,
  ItemFacts,
  LatestRevision,
  NewUpdate,
  StoredOperation,
} from '../application/ports.js';

// Arbitrary constant namespace for pg_advisory_xact_lock(int, int); see ADR-024 (pull cursor).
const SYNC_LOCK_NAMESPACE = 727_002;

export async function rowsOf<T>(db: DbHandle, query: SQL): Promise<T[]> {
  const result = await db.execute(query);
  return result.rows as T[];
}

/** `ARRAY[$1, $2, …]::uuid[]` built from bound parameters (no string interpolation). */
export function uuidArray(ids: readonly string[]): SQL {
  if (ids.length === 0) return sql`ARRAY[]::uuid[]`;
  return sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;
}

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

  constructor(private readonly db: DbHandle) {
    this.events = new DrizzleEventLog(db);
  }

  async lockProject(projectId: string): Promise<void> {
    await this.db.execute(
      sql`SELECT pg_advisory_xact_lock(${SYNC_LOCK_NAMESPACE}, hashtext(${projectId}))`,
    );
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
  constructor(private readonly db: Database) {}

  run<T>(work: (tx: ExecutionTx) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => work(new DrizzleExecutionTx(tx)));
  }
}
