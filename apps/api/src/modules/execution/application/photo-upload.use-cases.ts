import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { EVENT_ENTITIES, EVENT_TYPES, type PhotoUploadStatus } from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock } from '../../../common/clock.js';
import type { ObjectStorage } from '../../../common/object-storage.port.js';
import { decideChunk, looksLikeJpeg } from '../domain/photo-upload.js';
import type { PhotoUploadRow, PhotoUploadUnitOfWork } from './ports.js';

export const photoStorageKey = (projectId: string, photoId: string): string =>
  `projects/${projectId}/photos/${photoId}.jpg`;

function statusOf(row: PhotoUploadRow): PhotoUploadStatus {
  return {
    photoId: row.photoId,
    sizeBytes: row.sizeBytes,
    receivedBytes: row.receivedBytes,
    state: row.storedAt ? 'stored' : 'receiving',
  };
}

/**
 * Only the user who recorded the update may see or upload its photo. Anyone else gets NOT_FOUND,
 * so photo ids of other users cannot be probed (IDOR).
 */
function ownedBy(row: PhotoUploadRow | null, userId: string): PhotoUploadRow {
  if (!row || row.uploaderId !== userId) throw new AppError('NOT_FOUND', 'Photo not found');
  return row;
}

export class GetPhotoUploadStatusUseCase {
  constructor(private readonly uow: PhotoUploadUnitOfWork) {}

  async execute(input: {
    projectId: string;
    userId: string;
    photoId: string;
  }): Promise<PhotoUploadStatus> {
    return statusOf(ownedBy(await this.uow.find(input.projectId, input.photoId), input.userId));
  }
}

type ChunkOutcome =
  | { kind: 'status'; status: PhotoUploadStatus }
  | { kind: 'checksum_failed'; status: PhotoUploadStatus };

/** Appends one chunk of a resumable photo upload (ADR-024) and stores the photo when complete. */
export class PutPhotoChunkUseCase {
  constructor(
    private readonly uow: PhotoUploadUnitOfWork,
    private readonly storage: ObjectStorage,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    projectId: string;
    userId: string;
    photoId: string;
    offset: number;
    data: Buffer;
  }): Promise<PhotoUploadStatus> {
    const outcome = await this.uow.run(async (tx): Promise<ChunkOutcome> => {
      const row = ownedBy(await tx.findForUpdate(input.projectId, input.photoId), input.userId);
      if (row.storedAt) {
        // A resend of the last chunk after the response was lost: same answer as before.
        if (input.offset + input.data.length === row.sizeBytes) {
          return { kind: 'status', status: statusOf(row) };
        }
        throw new AppError('CONFLICT', 'Photo already stored', statusOf(row));
      }

      const decision = decideChunk({
        sizeBytes: row.sizeBytes,
        receivedBytes: row.receivedBytes,
        offset: input.offset,
        length: input.data.length,
      });
      switch (decision.kind) {
        case 'offset_mismatch':
          throw new AppError('CONFLICT', 'Upload-Offset does not match', statusOf(row));
        case 'empty':
          throw new AppError('VALIDATION_FAILED', 'Empty chunk');
        case 'too_large':
          throw new AppError('FILE_TOO_LARGE', 'More bytes than the declared size');
        case 'append':
          break;
      }

      await tx.appendChunk(input.photoId, input.offset, input.data, decision.receivedAfter);
      const progressed = { ...row, receivedBytes: decision.receivedAfter };
      if (!decision.complete) return { kind: 'status', status: statusOf(progressed) };

      const bytes = await tx.readChunks(input.photoId);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (sha256 !== row.sha256 || bytes.length !== row.sizeBytes || !looksLikeJpeg(bytes)) {
        await tx.resetUpload(input.photoId);
        return { kind: 'checksum_failed', status: statusOf({ ...row, receivedBytes: 0 }) };
      }

      const key = photoStorageKey(input.projectId, input.photoId);
      await this.writeOnce(key, bytes, sha256);
      const at = this.clock.now();
      await tx.markStored(input.photoId, key, at);
      await tx.appendEvent({
        projectId: input.projectId,
        entity: EVENT_ENTITIES.executionPhoto,
        entityId: input.photoId,
        type: EVENT_TYPES.executionPhotoStored,
        actorId: input.userId,
        payload: { updateId: row.updateId, sha256, sizeBytes: row.sizeBytes },
      });
      return { kind: 'status', status: statusOf({ ...progressed, storedAt: at }) };
    });

    if (outcome.kind === 'checksum_failed') {
      // Committed first: the bad bytes are gone and the device restarts from offset 0.
      throw new AppError(
        'VALIDATION_FAILED',
        'Photo does not match its sha256 or is not a JPEG',
        outcome.status,
        422,
      );
    }
    return outcome.status;
  }

  /**
   * Keys are write-once. If a previous attempt wrote the object but crashed before commit, the
   * object is accepted only when its content hashes to the same sha256.
   */
  private async writeOnce(key: string, bytes: Buffer, sha256: string): Promise<void> {
    try {
      await this.storage.put(key, Readable.from([bytes]), {
        contentType: 'image/jpeg',
        maxBytes: bytes.length,
      });
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'CONFLICT') throw error;
      const existing = createHash('sha256');
      for await (const chunk of await this.storage.get(key)) existing.update(chunk as Buffer);
      if (existing.digest('hex') !== sha256) throw error;
    }
  }
}
