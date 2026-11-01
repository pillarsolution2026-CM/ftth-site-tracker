import type { AsBuiltEdit } from '@ftth/shared';
import { sql } from 'drizzle-orm';
import { lockProjectForSync } from '../../../common/project-sync-lock.js';
import type { DomainEventInput } from '../../../common/event-log.port.js';
import type { Database, DbHandle } from '../../../db/db.module.js';
import { DrizzleEventLog } from '../../../db/drizzle-event-log.js';
import { rowsOf } from '../../../db/sql.js';
import type {
  AsBuiltReviewTx,
  AsBuiltReviewUnitOfWork,
  AsBuiltScope,
  EditForReview,
} from '../application/ports.js';
import type { ApprovedVersions } from '../domain/review.js';
import { EDIT_COLUMNS, editReadScope, mapEdit, type EditRow } from './asbuilt-sql.js';

export class DrizzleAsBuiltReviewTx implements AsBuiltReviewTx {
  private readonly events: DrizzleEventLog;

  constructor(
    private readonly db: DbHandle,
    private readonly lockTimeoutMs: number,
  ) {
    this.events = new DrizzleEventLog(db);
  }

  lockProject(projectId: string): Promise<void> {
    return lockProjectForSync(this.db, projectId, this.lockTimeoutMs);
  }

  async findEditForReview(
    projectId: string,
    editId: string,
    scope: AsBuiltScope,
  ): Promise<EditForReview | null> {
    // Scope is part of the query (IDOR); the row lock keeps a concurrent review out (we also
    // hold the project lock, the row lock is the last line of defence).
    const [row] = await rowsOf<{
      id: string;
      kind: EditForReview['kind'];
      feature_id: string;
      feature_type: EditForReview['featureType'];
      status: EditForReview['status'];
      base_version: number | null;
      user_id: string;
      label: string | null;
      has_geometry: boolean;
      length_m: string | null;
    }>(
      this.db,
      sql`SELECT e.id, e.kind, e.feature_id, e.feature_type, e.status, e.base_version, e.user_id,
                 e.label, (e.geom IS NOT NULL) AS has_geometry, e.length_m::text AS length_m
          FROM asbuilt_edits e
          WHERE e.project_id = ${projectId} AND e.id = ${editId}
            AND ${editReadScope(projectId, scope)}
          FOR UPDATE OF e`,
    );
    return row
      ? {
          id: row.id,
          kind: row.kind,
          featureId: row.feature_id,
          featureType: row.feature_type,
          status: row.status,
          baseVersion: row.base_version,
          userId: row.user_id,
          label: row.label,
          hasGeometry: row.has_geometry,
          lengthM: row.length_m,
        }
      : null;
  }

  async currentVersions(projectId: string, featureId: string): Promise<ApprovedVersions> {
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

  async markApproved(input: {
    projectId: string;
    editId: string;
    reviewerId: string;
    approvedVersion: number;
    at: Date;
  }): Promise<void> {
    await this.db.execute(sql`
      UPDATE asbuilt_edits
      SET status = 'approved', reviewed_by = ${input.reviewerId},
          reviewed_at = ${input.at.toISOString()}, approved_version = ${input.approvedVersion}
      WHERE project_id = ${input.projectId} AND id = ${input.editId} AND status = 'pending'`);
  }

  async markRejected(input: {
    projectId: string;
    editId: string;
    reviewerId: string;
    reason: string;
    at: Date;
  }): Promise<void> {
    await this.db.execute(sql`
      UPDATE asbuilt_edits
      SET status = 'rejected', reviewed_by = ${input.reviewerId},
          reviewed_at = ${input.at.toISOString()}, review_reason = ${input.reason}
      WHERE project_id = ${input.projectId} AND id = ${input.editId} AND status = 'pending'`);
  }

  async applyApproval(input: {
    projectId: string;
    editId: string;
    approvedVersion: number;
  }): Promise<void> {
    const [edit] = await rowsOf<{
      feature_id: string;
      feature_type: string;
      kind: AsBuiltEdit['kind'];
      has_geom: boolean;
      label: string | null;
    }>(
      this.db,
      sql`SELECT feature_id, feature_type, kind, (geom IS NOT NULL) AS has_geom, label
          FROM asbuilt_edits WHERE project_id = ${input.projectId} AND id = ${input.editId}`,
    );
    if (!edit) throw new Error('edit disappeared inside the transaction');
    const { projectId, editId, approvedVersion: version } = input;

    if (edit.kind === 'add_route' || edit.kind === 'add_symbol') {
      // Geometry and the optional label both arrive at version 1 (the add itself).
      await this.db.execute(sql`
        INSERT INTO asbuilt_features
          (project_id, feature_id, feature_type, added, geom, label,
           geometry_version, label_version, geometry_edit_id, label_edit_id)
        SELECT e.project_id, e.feature_id, e.feature_type, true, e.geom, e.label,
               ${version}::int, CASE WHEN e.label IS NULL THEN 0 ELSE ${version}::int END,
               e.id, CASE WHEN e.label IS NULL THEN NULL::uuid ELSE e.id END
        FROM asbuilt_edits e WHERE e.project_id = ${projectId} AND e.id = ${editId}`);
      return;
    }

    const [existing] = await rowsOf<{ feature_id: string }>(
      this.db,
      sql`SELECT feature_id FROM asbuilt_features
          WHERE project_id = ${projectId} AND feature_id = ${edit.feature_id} FOR UPDATE`,
    );

    if (edit.kind === 'label') {
      if (existing) {
        await this.db.execute(sql`
          UPDATE asbuilt_features a
          SET label = e.label, label_version = ${version}::int, label_edit_id = e.id
          FROM asbuilt_edits e
          WHERE e.project_id = ${projectId} AND e.id = ${editId}
            AND a.project_id = e.project_id AND a.feature_id = e.feature_id`);
      } else {
        await this.db.execute(sql`
          INSERT INTO asbuilt_features
            (project_id, feature_id, feature_type, added, geom, label,
             geometry_version, label_version, geometry_edit_id, label_edit_id)
          SELECT e.project_id, e.feature_id, e.feature_type, false, NULL::geometry, e.label,
                 0, ${version}::int, NULL::uuid, e.id
          FROM asbuilt_edits e WHERE e.project_id = ${projectId} AND e.id = ${editId}`);
      }
      return;
    }

    // move / reshape
    if (existing) {
      await this.db.execute(sql`
        UPDATE asbuilt_features a
        SET geom = e.geom, geometry_version = ${version}::int, geometry_edit_id = e.id
        FROM asbuilt_edits e
        WHERE e.project_id = ${projectId} AND e.id = ${editId}
          AND a.project_id = e.project_id AND a.feature_id = e.feature_id`);
    } else {
      await this.db.execute(sql`
        INSERT INTO asbuilt_features
          (project_id, feature_id, feature_type, added, geom, label,
           geometry_version, label_version, geometry_edit_id, label_edit_id)
        SELECT e.project_id, e.feature_id, e.feature_type, false, e.geom, NULL::text,
               ${version}::int, 0, e.id, NULL::uuid
        FROM asbuilt_edits e WHERE e.project_id = ${projectId} AND e.id = ${editId}`);
    }
  }

  async findEdit(projectId: string, editId: string): Promise<AsBuiltEdit> {
    const [row] = await rowsOf<EditRow>(
      this.db,
      sql`SELECT ${EDIT_COLUMNS}
          FROM asbuilt_edits e JOIN users u ON u.id = e.user_id
          WHERE e.project_id = ${projectId} AND e.id = ${editId}`,
    );
    if (!row) throw new Error('edit disappeared inside the transaction');
    return mapEdit(row);
  }

  appendEvent(event: DomainEventInput): Promise<void> {
    return this.events.append(event);
  }
}

export class DrizzleAsBuiltReviewUnitOfWork implements AsBuiltReviewUnitOfWork {
  constructor(
    private readonly db: Database,
    private readonly lockTimeoutMs: number,
  ) {}

  run<T>(work: (tx: AsBuiltReviewTx) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => work(new DrizzleAsBuiltReviewTx(tx, this.lockTimeoutMs)));
  }
}
