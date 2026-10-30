import { sql } from 'drizzle-orm';
import type { DomainEventInput } from '../../../common/event-log.port.js';
import type { Database, DbHandle } from '../../../db/db.module.js';
import { DrizzleEventLog } from '../../../db/drizzle-event-log.js';
import type { PhotoUploadRow, PhotoUploadTx, PhotoUploadUnitOfWork } from '../application/ports.js';
import { rowsOf, uuidArray } from './drizzle-execution.repository.js';

interface Row {
  id: string;
  project_id: string;
  user_id: string;
  sha256: string;
  size_bytes: number;
  received_bytes: number;
  stored_at: Date | null;
  update_id: string;
}

const toRow = (row: Row): PhotoUploadRow => ({
  photoId: row.id,
  projectId: row.project_id,
  uploaderId: row.user_id,
  sha256: row.sha256,
  sizeBytes: row.size_bytes,
  receivedBytes: row.received_bytes,
  storedAt: row.stored_at ? new Date(row.stored_at) : null,
  updateId: row.update_id,
});

async function findPhoto(
  db: DbHandle,
  projectId: string,
  photoId: string,
  lock: boolean,
): Promise<PhotoUploadRow | null> {
  const [row] = await rowsOf<Row>(
    db,
    sql`SELECT p.id, p.project_id, u.user_id, p.sha256, p.size_bytes, p.received_bytes,
               p.stored_at, p.update_id
        FROM execution_photos p
        JOIN execution_updates u ON u.project_id = p.project_id AND u.id = p.update_id
        WHERE p.project_id = ${projectId} AND p.id = ${photoId}
        ${lock ? sql`FOR UPDATE OF p` : sql``}`,
  );
  return row ? toRow(row) : null;
}

class DrizzlePhotoUploadTx implements PhotoUploadTx {
  constructor(private readonly db: DbHandle) {}

  findForUpdate(projectId: string, photoId: string): Promise<PhotoUploadRow | null> {
    return findPhoto(this.db, projectId, photoId, true);
  }

  async appendChunk(
    photoId: string,
    offset: number,
    data: Buffer,
    receivedAfter: number,
    at: Date,
  ): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO execution_photo_chunks (photo_id, offset_bytes, data)
      VALUES (${photoId}, ${offset}, ${data})`);
    await this.db.execute(sql`
      UPDATE execution_photos SET received_bytes = ${receivedAfter}, last_chunk_at = ${at.toISOString()}
      WHERE id = ${photoId}`);
  }

  async unfinishedBytesOf(userId: string): Promise<number> {
    const [row] = await rowsOf<{ bytes: string }>(
      this.db,
      sql`SELECT COALESCE(sum(p.received_bytes), 0)::text AS bytes
          FROM execution_photos p
          JOIN execution_updates u ON u.project_id = p.project_id AND u.id = p.update_id
          WHERE u.user_id = ${userId} AND p.stored_at IS NULL AND p.received_bytes > 0`,
    );
    return Number(row?.bytes ?? 0);
  }

  async readChunks(photoId: string): Promise<Buffer> {
    const rows = await rowsOf<{ data: Buffer }>(
      this.db,
      sql`SELECT data FROM execution_photo_chunks WHERE photo_id = ${photoId} ORDER BY offset_bytes`,
    );
    return Buffer.concat(rows.map((row) => row.data));
  }

  async resetUpload(photoId: string): Promise<void> {
    await this.db.execute(sql`DELETE FROM execution_photo_chunks WHERE photo_id = ${photoId}`);
    await this.db.execute(
      sql`UPDATE execution_photos SET received_bytes = 0 WHERE id = ${photoId}`,
    );
  }

  async markStored(photoId: string, storageKey: string, at: Date): Promise<void> {
    await this.db.execute(sql`
      UPDATE execution_photos SET storage_key = ${storageKey}, stored_at = ${at.toISOString()}
      WHERE id = ${photoId}`);
    await this.db.execute(sql`DELETE FROM execution_photo_chunks WHERE photo_id = ${photoId}`);
  }

  appendEvent(event: DomainEventInput): Promise<void> {
    return new DrizzleEventLog(this.db).append(event);
  }
}

export class DrizzlePhotoUploadUnitOfWork implements PhotoUploadUnitOfWork {
  constructor(private readonly db: Database) {}

  run<T>(work: (tx: PhotoUploadTx) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => work(new DrizzlePhotoUploadTx(tx)));
  }

  find(projectId: string, photoId: string): Promise<PhotoUploadRow | null> {
    return findPhoto(this.db, projectId, photoId, false);
  }

  async discardIdleUploads(before: Date): Promise<number> {
    return this.db.transaction(async (tx) => {
      // SKIP LOCKED: an upload receiving a chunk right now is left alone.
      const idle = await rowsOf<{ id: string }>(
        tx,
        sql`SELECT id FROM execution_photos
            WHERE stored_at IS NULL AND received_bytes > 0 AND last_chunk_at < ${before.toISOString()}
            FOR UPDATE SKIP LOCKED`,
      );
      if (idle.length === 0) return 0;
      const ids = uuidArray(idle.map((row) => row.id));
      await tx.execute(sql`DELETE FROM execution_photo_chunks WHERE photo_id = ANY(${ids})`);
      await tx.execute(sql`UPDATE execution_photos SET received_bytes = 0 WHERE id = ANY(${ids})`);
      return idle.length;
    });
  }
}
