import {
  EXECUTION_LIMITS,
  PhotoUploadStatusSchema,
  type OpResult,
  type PhotoUploadStatus,
} from '@ftth/shared';
import {
  TransportError,
  type OutboxEntry,
  type PendingPhoto,
  type PhotoSource,
  type SyncStore,
  type SyncTransport,
} from './ports.js';

/**
 * How a sync round ended:
 * - `ok`: outbox drained, photos uploaded, changes pulled.
 * - `offline`: no response (retry with backoff).
 * - `server_error`: 5xx / 429 (retry with backoff).
 * - `unauthorized`: the token was refused (refresh or log in again, then retry).
 * - `forbidden`: the user lost access to the project (do not retry automatically).
 */
export type SyncOutcome = 'ok' | 'offline' | 'server_error' | 'unauthorized' | 'forbidden';

export interface SyncReport {
  outcome: SyncOutcome;
  applied: number;
  duplicates: number;
  rejected: number;
  photosStored: number;
  photosFailed: number;
  pulled: number;
}

export interface SyncEngineOptions {
  store: SyncStore;
  transport: SyncTransport;
  photos: PhotoSource;
  deviceId: string;
  /** Operations per push request (≤ the server limit). */
  batchSize?: number;
  /** Bytes per upload request (≤ the server limit). */
  chunkBytes?: number;
  /** Complete uploads refused by the server before a photo is marked failed. */
  maxChecksumFailures?: number;
  pullPageSize?: number;
}

/** Stops the round; carries the outcome to report. */
class StopRound extends Error {
  constructor(readonly outcome: Exclude<SyncOutcome, 'ok'>) {
    super(outcome);
  }
}

const isHttp = (error: unknown, status: number): boolean =>
  error instanceof TransportError && error.status === status;

function statusIn(error: unknown): PhotoUploadStatus | null {
  if (!(error instanceof TransportError)) return null;
  const parsed = PhotoUploadStatusSchema.safeParse(error.details);
  return parsed.success ? parsed.data : null;
}

function outcomeOf(error: unknown): Exclude<SyncOutcome, 'ok'> | null {
  if (!(error instanceof TransportError)) return null;
  if (error.kind === 'network') return 'offline';
  if (error.status === 401) return 'unauthorized';
  if (error.status === 403) return 'forbidden';
  if (error.status === 429 || (error.status ?? 0) >= 500) return 'server_error';
  return null;
}

/**
 * Drives one device's sync (ADR-024): push the outbox, upload photos, pull changes. Every step
 * is safe to repeat: the server deduplicates by `clientOpId` and resumes uploads from its own
 * offset, so a round may be cut at any point and simply run again.
 */
export class SyncEngine {
  private readonly batchSize: number;
  private readonly chunkBytes: number;
  private readonly maxChecksumFailures: number;
  private readonly pullPageSize: number;
  private running: Promise<SyncReport> | null = null;

  constructor(private readonly options: SyncEngineOptions) {
    this.batchSize = Math.min(options.batchSize ?? 50, EXECUTION_LIMITS.maxOpsPerPush);
    this.chunkBytes = Math.min(options.chunkBytes ?? 256 * 1024, EXECUTION_LIMITS.maxChunkBytes);
    this.maxChecksumFailures = options.maxChecksumFailures ?? 3;
    this.pullPageSize = Math.min(options.pullPageSize ?? 200, EXECUTION_LIMITS.maxPullPage);
  }

  /** Runs a round; a call while one is running joins it instead of starting a second. */
  syncOnce(): Promise<SyncReport> {
    if (!this.running) {
      this.running = this.round().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async round(): Promise<SyncReport> {
    const report: SyncReport = {
      outcome: 'ok',
      applied: 0,
      duplicates: 0,
      rejected: 0,
      photosStored: 0,
      photosFailed: 0,
      pulled: 0,
    };
    try {
      await this.pushAll(report);
      await this.uploadPhotos(report);
      await this.pull(report);
    } catch (error) {
      if (error instanceof StopRound) report.outcome = error.outcome;
      else throw error;
    }
    return report;
  }

  // ---- push -----------------------------------------------------------------------------

  private async pushAll(report: SyncReport): Promise<void> {
    for (;;) {
      const batch = await this.options.store.pendingOps(this.batchSize);
      if (batch.length === 0) return;
      await this.pushBatch(batch, report);
    }
  }

  private async pushBatch(batch: readonly OutboxEntry[], report: SyncReport): Promise<void> {
    let results: OpResult[];
    try {
      const response = await this.options.transport.push({
        deviceId: this.options.deviceId,
        ops: batch.map((entry) => entry.op),
      });
      results = response.results;
    } catch (error) {
      const outcome = outcomeOf(error);
      if (outcome) {
        // The server may have applied the batch before the connection dropped; the resend
        // will come back as `duplicate`.
        await this.options.store.markAttemptFailed(batch.map((entry) => entry.clientOpId));
        throw new StopRound(outcome);
      }
      if (error instanceof TransportError && error.status === 400) {
        await this.isolateInvalid(batch, report);
        return;
      }
      throw error;
    }
    await this.recordResults(batch, results, report);
  }

  /**
   * The server refused the whole batch as invalid (should not happen: the device validates with
   * the same schemas). Send entries one by one so a single bad entry cannot block the outbox.
   */
  private async isolateInvalid(batch: readonly OutboxEntry[], report: SyncReport): Promise<void> {
    if (batch.length === 1) {
      const [entry] = batch;
      if (entry) {
        await this.options.store.markRejected(entry.clientOpId, 'VALIDATION_FAILED');
        report.rejected += 1;
      }
      return;
    }
    for (const entry of batch) await this.pushBatch([entry], report);
  }

  private async recordResults(
    batch: readonly OutboxEntry[],
    results: readonly OpResult[],
    report: SyncReport,
  ): Promise<void> {
    const byId = new Map(results.map((result) => [result.clientOpId, result]));
    for (const entry of batch) {
      const result = byId.get(entry.clientOpId);
      if (!result) {
        // Defensive: an answer without this entry leaves it pending for the next round.
        await this.options.store.markAttemptFailed([entry.clientOpId]);
        continue;
      }
      if (result.outcome === 'rejected') {
        await this.options.store.markRejected(entry.clientOpId, result.code);
        report.rejected += 1;
      } else {
        await this.options.store.markApplied(entry.clientOpId, result.updateId);
        if (result.outcome === 'applied') report.applied += 1;
        else report.duplicates += 1;
      }
    }
  }

  // ---- photos ---------------------------------------------------------------------------

  private async uploadPhotos(report: SyncReport): Promise<void> {
    for (const photo of await this.options.store.photosToUpload()) {
      await this.uploadPhoto(photo, report);
    }
  }

  private async uploadPhoto(photo: PendingPhoto, report: SyncReport): Promise<void> {
    const { store, transport } = this.options;
    let failures = photo.checksumFailures;
    try {
      let status = await transport.photoStatus(photo.photoId);
      let bytes: Uint8Array | null = null;
      while (status.state !== 'stored') {
        bytes ??= await this.options.photos.read(photo.photoId);
        const offset = status.receivedBytes;
        const chunk = bytes.subarray(offset, Math.min(offset + this.chunkBytes, bytes.length));
        try {
          status = await transport.putPhotoChunk(photo.photoId, offset, chunk);
        } catch (error) {
          // 422: the complete file failed the sha256/JPEG check and the server discarded it.
          // 409: the offset moved (e.g. a lost response). Both resume from the server's status.
          if (isHttp(error, 422)) {
            failures += 1;
            if (failures >= this.maxChecksumFailures) throw new PhotoFailed(failures);
          } else if (!isHttp(error, 409)) {
            throw error;
          }
          status = statusIn(error) ?? (await transport.photoStatus(photo.photoId));
        }
        await store.setPhotoProgress(photo.photoId, {
          uploadedBytes: status.receivedBytes,
          state: status.state === 'stored' ? 'stored' : 'waiting',
          checksumFailures: failures,
        });
      }
      if (photo.state !== 'stored') {
        await store.setPhotoProgress(photo.photoId, {
          uploadedBytes: status.receivedBytes,
          state: 'stored',
          checksumFailures: failures,
        });
      }
      report.photosStored += 1;
    } catch (error) {
      // 404/413: the server does not know this photo or its size; retrying cannot help.
      if (error instanceof PhotoFailed || isHttp(error, 404) || isHttp(error, 413)) {
        await store.setPhotoProgress(photo.photoId, {
          uploadedBytes: 0,
          state: 'failed',
          checksumFailures: failures,
        });
        report.photosFailed += 1;
        return;
      }
      const outcome = outcomeOf(error);
      if (outcome) throw new StopRound(outcome);
      throw error;
    }
  }

  // ---- pull -----------------------------------------------------------------------------

  private async pull(report: SyncReport): Promise<void> {
    const { store, transport } = this.options;
    let cursor = await store.getCursor();
    try {
      for (;;) {
        const page = await transport.changes(cursor, this.pullPageSize);
        await store.applyRemoteUpdates(page.updates);
        report.pulled += page.updates.length;
        cursor = page.cursor;
        await store.setCursor(cursor);
        if (!page.hasMore) return;
      }
    } catch (error) {
      const outcome = outcomeOf(error);
      if (outcome) throw new StopRound(outcome);
      throw error;
    }
  }
}

class PhotoFailed extends Error {
  constructor(readonly failures: number) {
    super('photo upload failed');
  }
}
