import type { Database } from '@nozbe/watermelondb';
import SQLiteAdapter from '@nozbe/watermelondb/adapters/sqlite';
import { createLocalDatabase } from './database';
import { localMigrations, localSchema } from './schema';

let instance: Database | null = null;

/** One SQLite database per app install (JSI adapter; needs the dev client, not Expo Go). */
export function nativeDatabase(): Database {
  instance ??= createLocalDatabase(
    new SQLiteAdapter({
      schema: localSchema,
      migrations: localMigrations,
      dbName: 'ftth_field',
      jsi: true,
    }),
  );
  return instance;
}
