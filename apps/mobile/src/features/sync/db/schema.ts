import { appSchema, tableSchema } from '@nozbe/watermelondb';

/**
 * Local database of the supervisor app (WatermelonDB / SQLite, ADR-024). Bump `version` and add
 * a migration for every change: phones keep their data across app updates.
 */
export const TABLES = {
  outbox: 'outbox_ops',
  photos: 'local_photos',
  remoteUpdates: 'remote_updates',
  keyValue: 'key_values',
} as const;

export const localSchema = appSchema({
  version: 1,
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
    tableSchema({
      name: TABLES.keyValue,
      columns: [
        { name: 'key', type: 'string', isIndexed: true },
        { name: 'value', type: 'string' },
      ],
    }),
  ],
});
