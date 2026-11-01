import type { AsBuiltExport } from '@ftth/shared';
import { sql } from 'drizzle-orm';
import type { DomainEventInput } from '../../../common/event-log.port.js';
import type { Database, DbHandle } from '../../../db/db.module.js';
import { DrizzleEventLog } from '../../../db/drizzle-event-log.js';
import { rowsOf } from '../../../db/sql.js';
import type {
  AsBuiltExportQueries,
  AsBuiltExportTx,
  AsBuiltExportUnitOfWork,
  ExportRecord,
} from '../application/ports.js';
import { iso } from './asbuilt-sql.js';

interface ExportRow {
  id: string;
  revision_id: string;
  rev_no: number;
  status: AsBuiltExport['status'];
  requested_by: string;
  requested_at: Date;
  finished_at: Date | null;
  stats: AsBuiltExport['stats'];
  size_bytes: string | number | null;
  error_code: string | null;
  storage_key: string | null;
}

const COLUMNS = sql`x.id, x.revision_id, r.rev_no, x.status, x.requested_by, x.requested_at,
  x.finished_at, x.stats, x.size_bytes, x.error_code, x.storage_key`;

function toRecord(row: ExportRow): ExportRecord {
  return {
    id: row.id,
    revisionId: row.revision_id,
    revNo: row.rev_no,
    status: row.status,
    requestedBy: row.requested_by,
    requestedAt: iso(row.requested_at),
    finishedAt: row.finished_at ? iso(row.finished_at) : null,
    stats: row.stats,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    error: row.error_code,
    storageKey: row.storage_key,
  };
}

async function findExport(
  db: DbHandle,
  projectId: string,
  exportId: string,
): Promise<ExportRecord | null> {
  const [row] = await rowsOf<ExportRow>(
    db,
    sql`SELECT ${COLUMNS}
        FROM asbuilt_exports x
        JOIN design_revisions r ON r.project_id = x.project_id AND r.id = x.revision_id
        WHERE x.project_id = ${projectId} AND x.id = ${exportId}`,
  );
  return row ? toRecord(row) : null;
}

export class DrizzleAsBuiltExportQueries implements AsBuiltExportQueries {
  constructor(private readonly db: DbHandle) {}

  async list(projectId: string, limit: number): Promise<AsBuiltExport[]> {
    const rows = await rowsOf<ExportRow>(
      this.db,
      sql`SELECT ${COLUMNS}
          FROM asbuilt_exports x
          JOIN design_revisions r ON r.project_id = x.project_id AND r.id = x.revision_id
          WHERE x.project_id = ${projectId}
          ORDER BY x.requested_at DESC, x.id DESC
          LIMIT ${limit}`,
    );
    return rows.map((row) => {
      const record = toRecord(row);
      return {
        id: record.id,
        revisionId: record.revisionId,
        status: record.status,
        requestedBy: record.requestedBy,
        requestedAt: record.requestedAt,
        finishedAt: record.finishedAt,
        stats: record.stats,
        sizeBytes: record.sizeBytes,
        error: record.error,
      };
    });
  }

  find(projectId: string, exportId: string): Promise<ExportRecord | null> {
    return findExport(this.db, projectId, exportId);
  }
}

class DrizzleAsBuiltExportTx implements AsBuiltExportTx {
  private readonly events: DrizzleEventLog;

  constructor(private readonly db: DbHandle) {
    this.events = new DrizzleEventLog(db);
  }

  async latestPublishedRevision(projectId: string): Promise<{ id: string; revNo: number } | null> {
    const [row] = await rowsOf<{ id: string; rev_no: number }>(
      this.db,
      sql`SELECT id, rev_no FROM design_revisions
          WHERE project_id = ${projectId} AND status = 'published'
          ORDER BY rev_no DESC LIMIT 1`,
    );
    return row ? { id: row.id, revNo: row.rev_no } : null;
  }

  async insert(input: {
    id: string;
    projectId: string;
    revisionId: string;
    jobId: string;
    requestedBy: string;
    at: Date;
  }): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO asbuilt_exports (id, project_id, revision_id, status, current_job_id, requested_by, requested_at)
      VALUES (${input.id}, ${input.projectId}, ${input.revisionId}, 'queued', ${input.jobId},
              ${input.requestedBy}, ${input.at.toISOString()})`);
  }

  async markEnqueueFailed(
    projectId: string,
    exportId: string,
    jobId: string,
    at: Date,
  ): Promise<boolean> {
    const rows = await rowsOf(
      this.db,
      sql`UPDATE asbuilt_exports
          SET status = 'failed', error_code = 'ENQUEUE_FAILED', finished_at = ${at.toISOString()}
          WHERE project_id = ${projectId} AND id = ${exportId}
            AND current_job_id = ${jobId} AND status = 'queued'
          RETURNING id`,
    );
    return rows.length > 0;
  }

  find(projectId: string, exportId: string): Promise<ExportRecord | null> {
    return findExport(this.db, projectId, exportId);
  }

  appendEvent(event: DomainEventInput): Promise<void> {
    return this.events.append(event);
  }
}

export class DrizzleAsBuiltExportUnitOfWork implements AsBuiltExportUnitOfWork {
  constructor(private readonly db: Database) {}

  run<T>(work: (tx: AsBuiltExportTx) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => work(new DrizzleAsBuiltExportTx(tx)));
  }
}
