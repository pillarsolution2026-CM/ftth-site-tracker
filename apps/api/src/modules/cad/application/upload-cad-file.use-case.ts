import type { Readable } from 'node:stream';
import {
  EVENT_ENTITIES,
  EVENT_TYPES,
  type DrawingKind,
  type KindExistsDetails,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock, IdGenerator } from '../../../common/clock.js';
import { storageKeys, type ObjectStorage } from '../../../common/object-storage.port.js';
import { discardObject } from '../../../common/storage/discard-object.js';
import { peekStream } from '../../../common/storage/peek-stream.js';
import type { CadFile } from '../domain/cad-file.js';
import type { CadUnitOfWork } from '../domain/cad-file.repository.js';
import { declaredFormat, SNIFF_BYTES, verifyCadContent } from '../domain/cad-sniffer.js';
import { discardRevisionInTx } from './discard-design-revision.use-case.js';
import { enqueueAfterCommit } from './cad-enqueue.js';
import type { JobQueue } from './ports.js';

function kindExists(kind: DrawingKind, current: CadFile): AppError {
  const details: KindExistsDetails = {
    reason: 'KIND_EXISTS',
    kind,
    currentFileId: current.id,
    currentFileName: current.originalName,
  };
  return new AppError(
    'CONFLICT',
    'This work order already has a drawing of this kind; confirm it is a new version',
    details,
  );
}

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
    /** General or Secondary (ADR-040). */
    kind: DrawingKind;
    /** «Yes, a new version of the current file of this kind»: it supersedes the current one. */
    newVersion: boolean;
  }): Promise<CadFile> {
    const { projectId, actorId, file, kind, newVersion } = input;
    const format = declaredFormat(file.fileName);
    const { head, stream } = await peekStream(file.stream, SNIFF_BYTES);
    verifyCadContent(format, head);

    // Cheap pre-check so a refused upload never stores the file; the locked check below decides.
    if (!newVersion) {
      const existing = await this.uow.run((tx) => tx.files.listCurrentOfKind(projectId, kind));
      if (existing[0]) throw kindExists(kind, existing[0]);
    }

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
      drawingKind: kind,
      supersededAt: null,
      supersededById: null,
      currentJobId: null,
      converter: null,
      converterVersion: null,
      dxfVersion: null,
      insUnits: null,
      extents: null,
      crsDetection: null,
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
        // Serialises uploads of this kind: the one-current-file-per-kind rule lives here.
        const current = await tx.files.lockCurrentOfKind(projectId, kind);
        const newest = current[0];
        if (newest && !newVersion) throw kindExists(kind, newest);
        const supersededFileIds = current.map((f) => f.id);
        // A new version makes the open revision of the kind (built from an older file) useless:
        // discard it, whatever its state, and supersede a worker still building it (owner, M1).
        let discardedRevisionId: string | null = null;
        if (newest) {
          const open = await tx.revisions.findOpen(projectId, kind);
          const locked = open ? await tx.revisions.find(projectId, open.id, { lock: true }) : null;
          if (locked) {
            await discardRevisionInTx(tx, {
              revision: locked,
              actorId,
              supersedingJobId: this.ids.next(),
            });
            discardedRevisionId = locked.id;
          }
        }
        await tx.files.insertUploaded(uploaded);
        await tx.files.supersede(projectId, supersededFileIds, id, now);
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
            drawingKind: kind,
            supersededFileIds,
            discardedRevisionId,
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
