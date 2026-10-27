import type { Readable } from 'node:stream';
import { EVENT_ENTITIES, EVENT_TYPES } from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock, IdGenerator } from '../../../common/clock.js';
import { storageKeys, type ObjectStorage } from '../../../common/object-storage.port.js';
import { discardObject } from '../../../common/storage/discard-object.js';
import { peekStream } from '../../../common/storage/peek-stream.js';
import type { CadFile } from '../domain/cad-file.js';
import type { CadUnitOfWork } from '../domain/cad-file.repository.js';
import { declaredFormat, SNIFF_BYTES, verifyCadContent } from '../domain/cad-sniffer.js';
import { enqueueAfterCommit } from './cad-enqueue.js';
import type { JobQueue } from './ports.js';

export class UploadCadFileUseCase {
  constructor(
    private readonly uow: CadUnitOfWork,
    private readonly storage: ObjectStorage,
    private readonly queue: JobQueue,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly maxBytes: number,
  ) {}

  async execute(input: {
    projectId: string;
    actorId: string;
    file: { fileName: string; stream: Readable };
  }): Promise<CadFile> {
    const { projectId, actorId, file } = input;
    const format = declaredFormat(file.fileName);
    const { head, stream } = await peekStream(file.stream, SNIFF_BYTES);
    verifyCadContent(format, head);

    const id = this.ids.next();
    const jobId = this.ids.next();
    const storageKey = storageKeys.cadOriginal(projectId, id, format);
    const stored = await this.storage.put(storageKey, stream, {
      contentType: 'application/octet-stream',
      maxBytes: this.maxBytes,
    });
    if (stored.sizeBytes === 0) {
      await discardObject(this.storage, storageKey);
      throw new AppError('UNSUPPORTED_FILE', 'The file is empty');
    }

    const now = this.clock.now();
    const uploaded: CadFile = {
      id,
      projectId,
      originalName: file.fileName,
      format,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      storageKey,
      convertedStorageKey: null,
      status: 'uploaded',
      currentJobId: null,
      converter: null,
      converterVersion: null,
      dxfVersion: null,
      insUnits: null,
      extents: null,
      counts: null,
      warnings: [],
      errorCode: null,
      errorMessage: null,
      uploadedById: actorId,
      createdAt: now,
      updatedAt: now,
      queuedAt: null,
      processingStartedAt: null,
      processedAt: null,
    };

    try {
      await this.uow.run(async (tx) => {
        await tx.files.insertUploaded(uploaded);
        await tx.events.append({
          projectId,
          entity: EVENT_ENTITIES.cadFile,
          entityId: id,
          type: EVENT_TYPES.cadFileUploaded,
          actorId,
          payload: {
            originalName: uploaded.originalName,
            format,
            sizeBytes: uploaded.sizeBytes,
            sha256: uploaded.sha256,
          },
        });
        await tx.files.markQueued(projectId, id, jobId, now);
        await tx.events.append({
          projectId,
          entity: EVENT_ENTITIES.cadFile,
          entityId: id,
          type: EVENT_TYPES.cadFileQueued,
          actorId,
          payload: { jobId, attempt: 1 },
        });
      });
    } catch (error) {
      await discardObject(this.storage, storageKey);
      throw error;
    }

    const queued: CadFile = { ...uploaded, status: 'queued', currentJobId: jobId, queuedAt: now };
    await enqueueAfterCommit(this.queue, this.uow, this.clock, queued, jobId, actorId);
    return this.reload(queued);
  }

  private async reload(file: CadFile): Promise<CadFile> {
    const current = await this.uow.run((tx) => tx.files.find(file.projectId, file.id));
    return current ?? file;
  }
}
