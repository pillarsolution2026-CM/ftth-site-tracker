import { sql, type SQL } from 'drizzle-orm';
import type { DbHandle } from './db.module.js';

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
