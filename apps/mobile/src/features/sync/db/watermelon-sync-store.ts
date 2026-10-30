import { Q, type Database } from '@nozbe/watermelondb';
import {
  ExecutionUpdateSchema,
  SyncOpSchema,
  type ExecutionUpdate,
  type SyncOp,
} from '@ftth/shared';
import type {
  EntryRejection,
  OutboxEntry,
  OutboxState,
  PendingPhoto,
  PhotoSource,
  PhotoState,
  SyncStore,
} from '@ftth/sync';
import type {
  KeyValueRecord,
  LocalPhotoRecord,
  OutboxOpRecord,
  RemoteUpdateRecord,
} from './models';
import { num, optionalStr, str } from './models';
import { TABLES } from './schema';

/** Reads the bytes of a photo file kept on the device (expo-file-system in the app). */
export type ReadFileBytes = (uri: string) => Promise<Uint8Array>;

export interface LocalPhotoFile {
  photoId: string;
  fileUri: string;
  sizeBytes: number;
}

export interface OutboxSummary {
  pending: number;
  rejected: number;
  photosWaiting: number;
  photosFailed: number;
}

const KEYS = { cursor: 'sync.cursor', lastSyncAt: 'sync.last_ok_at' } as const;

function toEntry(record: Model): OutboxEntry {
  return {
    clientOpId: str(record, 'client_op_id'),
    op: SyncOpSchema.parse(JSON.parse(str(record, 'op_json'))),
    state: str(record, 'state') as OutboxState,
    attempts: num(record, 'attempts'),
    updateId: optionalStr(record, 'update_id'),
    rejection: optionalStr(record, 'rejection') as EntryRejection | null,
  };
}

type Model = OutboxOpRecord | LocalPhotoRecord | RemoteUpdateRecord | KeyValueRecord;

/**
 * `SyncStore` on WatermelonDB (ADR-024). Saving an update writes its outbox row and photo rows in
 * one local transaction, so a crash never leaves an operation without its photos or vice versa.
 */
export class WatermelonSyncStore implements SyncStore, PhotoSource {
  constructor(
    private readonly db: Database,
    private readonly projectId: string,
    private readonly readFileBytes: ReadFileBytes,
  ) {}

  private get outbox() {
    return this.db.get<OutboxOpRecord>(TABLES.outbox);
  }
  private get photos() {
    return this.db.get<LocalPhotoRecord>(TABLES.photos);
  }
  private get remote() {
    return this.db.get<RemoteUpdateRecord>(TABLES.remoteUpdates);
  }
  private get kv() {
    return this.db.get<KeyValueRecord>(TABLES.keyValue);
  }

  /** Saves a validated operation and its photo files in one local transaction. */
  async enqueue(op: SyncOp, files: readonly LocalPhotoFile[]): Promise<void> {
    const valid = SyncOpSchema.parse(op);
    const declared = new Set(valid.payload.photos.map((photo) => photo.photoId));
    if (files.length !== declared.size || files.some((file) => !declared.has(file.photoId))) {
      throw new Error('Photo files do not match the operation');
    }
    await this.db.write(async () => {
      const last = await this.outbox.query(Q.sortBy('seq', Q.desc), Q.take(1)).fetch();
      const seq = (last[0] ? num(last[0], 'seq') : 0) + 1;
      const batch = [
        this.outbox.prepareCreate((record) => {
          record._setRaw('client_op_id', valid.clientOpId);
          record._setRaw('seq', seq);
          record._setRaw('project_id', this.projectId);
          record._setRaw('feature_id', valid.payload.featureId);
          record._setRaw('op_json', JSON.stringify(valid));
          record._setRaw('state', 'pending');
          record._setRaw('attempts', 0);
        }),
        ...files.map((file) =>
          this.photos.prepareCreate((record) => {
            record._setRaw('photo_id', file.photoId);
            record._setRaw('client_op_id', valid.clientOpId);
            record._setRaw('file_uri', file.fileUri);
            record._setRaw('size_bytes', file.sizeBytes);
            record._setRaw('uploaded_bytes', 0);
            record._setRaw('state', 'waiting');
            record._setRaw('checksum_failures', 0);
          }),
        ),
      ];
      await this.db.batch(...batch);
    });
  }

  async pendingOps(limit: number): Promise<OutboxEntry[]> {
    const records = await this.outbox
      .query(
        Q.where('project_id', this.projectId),
        Q.where('state', 'pending'),
        Q.sortBy('seq', Q.asc),
        Q.take(limit),
      )
      .fetch();
    return records.map(toEntry);
  }

  async entries(): Promise<OutboxEntry[]> {
    const records = await this.outbox
      .query(Q.where('project_id', this.projectId), Q.sortBy('seq', Q.desc))
      .fetch();
    return records.map(toEntry);
  }

  private async findOp(clientOpId: string): Promise<OutboxOpRecord> {
    const [record] = await this.outbox.query(Q.where('client_op_id', clientOpId)).fetch();
    if (!record) throw new Error(`Unknown outbox entry ${clientOpId}`);
    return record;
  }

  async markApplied(clientOpId: string, updateId: string): Promise<void> {
    const record = await this.findOp(clientOpId);
    await this.db.write(() =>
      record.update((r) => {
        r._setRaw('state', 'applied');
        r._setRaw('update_id', updateId);
      }),
    );
  }

  async markRejected(clientOpId: string, rejection: EntryRejection): Promise<void> {
    const record = await this.findOp(clientOpId);
    await this.db.write(() =>
      record.update((r) => {
        r._setRaw('state', 'rejected');
        r._setRaw('rejection', rejection);
      }),
    );
  }

  async markAttemptFailed(clientOpIds: readonly string[]): Promise<void> {
    const records = await this.outbox
      .query(Q.where('client_op_id', Q.oneOf([...clientOpIds])))
      .fetch();
    await this.db.write(async () => {
      await this.db.batch(
        ...records.map((record) =>
          record.prepareUpdate((r) => r._setRaw('attempts', num(record, 'attempts') + 1)),
        ),
      );
    });
  }

  async photosToUpload(): Promise<PendingPhoto[]> {
    const applied = await this.outbox
      .query(Q.where('project_id', this.projectId), Q.where('state', 'applied'))
      .fetch();
    const ids = applied.map((record) => str(record, 'client_op_id'));
    if (ids.length === 0) return [];
    const records = await this.photos
      .query(Q.where('client_op_id', Q.oneOf(ids)), Q.where('state', 'waiting'))
      .fetch();
    return records.map((record) => ({
      photoId: str(record, 'photo_id'),
      clientOpId: str(record, 'client_op_id'),
      sizeBytes: num(record, 'size_bytes'),
      uploadedBytes: num(record, 'uploaded_bytes'),
      state: str(record, 'state') as PhotoState,
      checksumFailures: num(record, 'checksum_failures'),
    }));
  }

  async setPhotoProgress(
    photoId: string,
    progress: { uploadedBytes: number; state: PhotoState; checksumFailures: number },
  ): Promise<void> {
    const [record] = await this.photos.query(Q.where('photo_id', photoId)).fetch();
    if (!record) throw new Error(`Unknown photo ${photoId}`);
    await this.db.write(() =>
      record.update((r) => {
        r._setRaw('uploaded_bytes', progress.uploadedBytes);
        r._setRaw('state', progress.state);
        r._setRaw('checksum_failures', progress.checksumFailures);
      }),
    );
  }

  /** Stored photos may be deleted from the device to free space (the server has them). */
  async storedPhotoUris(): Promise<string[]> {
    const records = await this.photos.query(Q.where('state', 'stored')).fetch();
    return records.map((record) => str(record, 'file_uri'));
  }

  async read(photoId: string): Promise<Uint8Array> {
    const [record] = await this.photos.query(Q.where('photo_id', photoId)).fetch();
    if (!record) throw new Error(`Unknown photo ${photoId}`);
    return this.readFileBytes(str(record, 'file_uri'));
  }

  private async getValue(key: string): Promise<string | null> {
    const [record] = await this.kv.query(Q.where('key', `${this.projectId}:${key}`)).fetch();
    return record ? str(record, 'value') : null;
  }

  private async setValue(key: string, value: string): Promise<void> {
    const scoped = `${this.projectId}:${key}`;
    const [record] = await this.kv.query(Q.where('key', scoped)).fetch();
    await this.db.write(async () => {
      if (record) await record.update((r) => r._setRaw('value', value));
      else
        await this.kv.create((r) => {
          r._setRaw('key', scoped);
          r._setRaw('value', value);
        });
    });
  }

  async getCursor(): Promise<string> {
    return (await this.getValue(KEYS.cursor)) ?? '0';
  }

  setCursor(cursor: string): Promise<void> {
    return this.setValue(KEYS.cursor, cursor);
  }

  getLastSyncAt(): Promise<string | null> {
    return this.getValue(KEYS.lastSyncAt);
  }

  setLastSyncAt(iso: string): Promise<void> {
    return this.setValue(KEYS.lastSyncAt, iso);
  }

  async applyRemoteUpdates(updates: readonly ExecutionUpdate[]): Promise<void> {
    if (updates.length === 0) return;
    const existing = await this.remote
      .query(Q.where('update_id', Q.oneOf(updates.map((update) => update.id))))
      .fetch();
    const byId = new Map(existing.map((record) => [str(record, 'update_id'), record]));
    await this.db.write(async () => {
      await this.db.batch(
        ...updates.map((update) => {
          const json = JSON.stringify(update);
          const record = byId.get(update.id);
          if (record) {
            return record.prepareUpdate((r) => {
              r._setRaw('status', update.status);
              r._setRaw('json', json);
            });
          }
          return this.remote.prepareCreate((r) => {
            r._setRaw('update_id', update.id);
            r._setRaw('client_op_id', update.clientOpId);
            r._setRaw('feature_id', update.featureId);
            r._setRaw('status', update.status);
            r._setRaw('json', json);
          });
        }),
      );
    });
  }

  /** Server copies of updates on a feature (feature card history). */
  async remoteUpdatesFor(featureId: string): Promise<ExecutionUpdate[]> {
    const records = await this.remote.query(Q.where('feature_id', featureId)).fetch();
    return records.map((record) => ExecutionUpdateSchema.parse(JSON.parse(str(record, 'json'))));
  }

  async summary(): Promise<OutboxSummary> {
    const count = (state: string) =>
      this.outbox
        .query(Q.where('project_id', this.projectId), Q.where('state', state))
        .fetchCount();
    const photoCount = (state: string) => this.photos.query(Q.where('state', state)).fetchCount();
    return {
      pending: await count('pending'),
      rejected: await count('rejected'),
      photosWaiting: await photoCount('waiting'),
      photosFailed: await photoCount('failed'),
    };
  }
}
