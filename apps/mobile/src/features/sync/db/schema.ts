import { appSchema, tableSchema } from '@nozbe/watermelondb';
import { createTable, schemaMigrations } from '@nozbe/watermelondb/Schema/migrations';

/**
 * Local database of the supervisor app (WatermelonDB / SQLite, ADR-024). Bump `version` and add
 * a migration for every change: phones keep their data across app updates.
 */
export const TABLES = {
  outbox: 'outbox_ops',
  photos: 'local_photos',
  remoteUpdates: 'remote_updates',
  remoteAsBuilt: 'remote_asbuilt_edits',
  keyValue: 'key_values',
} as const;

/** Server copies of As-Built edits (ADR-030); added in schema version 2. */
const remoteAsBuiltEditsTable: Parameters<typeof tableSchema>[0] = {
  name: TABLES.remoteAsBuilt,
  columns: [
    { name: 'edit_id', type: 'string', isIndexed: true },
    { name: 'client_op_id', type: 'string', isIndexed: true },
    { name: 'project_id', type: 'string', isIndexed: true },
    { name: 'user_id', type: 'string', isIndexed: true },
    { name: 'feature_id', type: 'string', isIndexed: true },
    { name: 'status', type: 'string', isIndexed: true },
    // Sealed JSON (ADR-025), like `remote_updates.json`.
    { name: 'json', type: 'string' },
  ],
};

export const LOCAL_SCHEMA_VERSION = 2;

/** Phones keep their data across updates: version 1 → 2 adds the As-Built edits table. */
export const localMigrations = schemaMigrations({
  migrations: [{ toVersion: 2, steps: [createTable(remoteAsBuiltEditsTable)] }],
});

export const localSchema = appSchema({
  version: LOCAL_SCHEMA_VERSION,
  tables: [
    tableSchema({
      name: TABLES.outbox,
      columns: [
        { name: 'client_op_id', type: 'string', isIndexed: true },
        // Creation order on this device; the outbox is drained oldest first.
        { name: 'seq', type: 'number', isIndexed: true },
        { name: 'project_id', type: 'string', isIndexed: true },
        // The signed-in user who recorded it; only that user's session ever sends it.
        { name: 'user_id', type: 'string', isIndexed: true },
        { name: 'feature_id', type: 'string', isIndexed: true },
        { name: 'op_json', type: 'string' },
        { name: 'state', type: 'string', isIndexed: true },
        { name: 'attempts', type: 'number' },
        { name: 'update_id', type: 'string', isOptional: true },
        { name: 'rejection', type: 'string', isOptional: true },
      ],
    }),
    tableSchema({
      name: TABLES.photos,
      columns: [
        { name: 'photo_id', type: 'string', isIndexed: true },
        { name: 'client_op_id', type: 'string', isIndexed: true },
        { name: 'user_id', type: 'string', isIndexed: true },
        { name: 'file_uri', type: 'string' },
        { name: 'size_bytes', type: 'number' },
        { name: 'uploaded_bytes', type: 'number' },
        { name: 'state', type: 'string', isIndexed: true },
        { name: 'checksum_failures', type: 'number' },
      ],
    }),
    tableSchema({
      name: TABLES.remoteUpdates,
      columns: [
        { name: 'update_id', type: 'string', isIndexed: true },
        { name: 'client_op_id', type: 'string', isIndexed: true },
        { name: 'project_id', type: 'string', isIndexed: true },
        { name: 'user_id', type: 'string', isIndexed: true },
        { name: 'feature_id', type: 'string', isIndexed: true },
        { name: 'status', type: 'string', isIndexed: true },
        { name: 'json', type: 'string' },
      ],
    }),
    tableSchema(remoteAsBuiltEditsTable),
    tableSchema({
      name: TABLES.keyValue,
      columns: [
        { name: 'key', type: 'string', isIndexed: true },
        { name: 'value', type: 'string' },
      ],
    }),
  ],
});
