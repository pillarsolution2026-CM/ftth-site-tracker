import type { ExecutionUpdate, SyncOp } from '@ftth/shared';
import type {
  EntryRejection,
  OutboxEntry,
  PendingPhoto,
  PhotoSource,
  PhotoState,
  SyncStore,
} from './ports.js';

/**
 * In-memory outbox and photo store: the reference implementation of `SyncStore`, used by tests
 * and by the multi-device simulations. The phone uses WatermelonDB with the same semantics.
 */
export class InMemorySyncStore implements SyncStore, PhotoSource {
  private readonly entries: OutboxEntry[] = [];
  private readonly photos = new Map<string, PendingPhoto & { bytes: Uint8Array }>();
  private cursor = '0';
  readonly remote = new Map<string, ExecutionUpdate>();

  /** Saves an operation and its photo bytes, as the update tool does in one local transaction. */
  enqueue(op: SyncOp, photoBytes: ReadonlyMap<string, Uint8Array>): void {
    this.entries.push({
      clientOpId: op.clientOpId,
      op,
      state: 'pending',
      attempts: 0,
      updateId: null,
      rejection: null,
    });
    for (const photo of op.payload.photos) {
      const bytes = photoBytes.get(photo.photoId);
      if (!bytes) throw new Error(`missing bytes for photo ${photo.photoId}`);
      this.photos.set(photo.photoId, {
        photoId: photo.photoId,
        clientOpId: op.clientOpId,
        sizeBytes: bytes.length,
        uploadedBytes: 0,
        state: 'waiting',
        checksumFailures: 0,
        bytes,
      });
    }
  }

  all(): readonly OutboxEntry[] {
    return this.entries;
  }

  photo(photoId: string): PendingPhoto | undefined {
    return this.photos.get(photoId);
  }

  async pendingOps(limit: number): Promise<OutboxEntry[]> {
    return this.entries.filter((entry) => entry.state === 'pending').slice(0, limit);
  }

  async markApplied(clientOpId: string, updateId: string): Promise<void> {
    const entry = this.find(clientOpId);
    entry.state = 'applied';
    entry.updateId = updateId;
  }

  async markRejected(clientOpId: string, rejection: EntryRejection): Promise<void> {
    const entry = this.find(clientOpId);
    entry.state = 'rejected';
    entry.rejection = rejection;
  }

  async markAttemptFailed(clientOpIds: readonly string[]): Promise<void> {
    for (const id of clientOpIds) this.find(id).attempts += 1;
  }

  async photosToUpload(): Promise<PendingPhoto[]> {
    const applied = new Set(
      this.entries.filter((entry) => entry.state === 'applied').map((entry) => entry.clientOpId),
    );
    return [...this.photos.values()]
      .filter((photo) => photo.state === 'waiting' && applied.has(photo.clientOpId))
      .map((photo) => ({
        photoId: photo.photoId,
        clientOpId: photo.clientOpId,
        sizeBytes: photo.sizeBytes,
        uploadedBytes: photo.uploadedBytes,
        state: photo.state,
        checksumFailures: photo.checksumFailures,
      }));
  }

  async setPhotoProgress(
    photoId: string,
    progress: { uploadedBytes: number; state: PhotoState; checksumFailures: number },
  ): Promise<void> {
    const photo = this.photos.get(photoId);
    if (!photo) throw new Error(`unknown photo ${photoId}`);
    Object.assign(photo, progress);
  }

  async getCursor(): Promise<string> {
    return this.cursor;
  }

  async setCursor(cursor: string): Promise<void> {
    this.cursor = cursor;
  }

  async applyRemoteUpdates(updates: readonly ExecutionUpdate[]): Promise<void> {
    for (const update of updates) this.remote.set(update.id, update);
  }

  async read(photoId: string): Promise<Uint8Array> {
    const photo = this.photos.get(photoId);
    if (!photo) throw new Error(`unknown photo ${photoId}`);
    return photo.bytes;
  }

  private find(clientOpId: string): OutboxEntry {
    const entry = this.entries.find((candidate) => candidate.clientOpId === clientOpId);
    if (!entry) throw new Error(`unknown op ${clientOpId}`);
    return entry;
  }
}
