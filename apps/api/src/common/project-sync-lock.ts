import { sql } from 'drizzle-orm';
import type { DbHandle } from '../db/db.module.js';
import { lockNotAvailable } from '../db/pg-errors.js';
import { AppError } from './app-error.js';

// Arbitrary constant namespace for pg_advisory_xact_lock(int, int); see ADR-024 (pull cursor).
const SYNC_LOCK_NAMESPACE = 727_002;

/**
 * Serialises every write that takes a `sync_seq` in one project (device pushes and As-Built
 * reviews) so sequence order equals commit order and a pull cursor never skips a row. The lock
 * is held until the surrounding transaction ends. A bounded wait keeps one device from holding
 * every other writer (security review M4): on timeout the caller gets 429 RATE_LIMITED.
 */
export async function lockProjectForSync(
  db: DbHandle,
  projectId: string,
  lockTimeoutMs: number,
): Promise<void> {
  await db.execute(sql`SELECT set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true)`);
  try {
    await db.execute(
      sql`SELECT pg_advisory_xact_lock(${SYNC_LOCK_NAMESPACE}, hashtext(${projectId}))`,
    );
  } catch (error) {
    if (lockNotAvailable(error)) {
      throw new AppError('RATE_LIMITED', 'The project is busy syncing; retry shortly');
    }
    throw error;
  }
}
