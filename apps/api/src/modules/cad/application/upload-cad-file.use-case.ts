import type { Readable } from 'node:stream';
import {
  EVENT_ENTITIES,
  EVENT_TYPES,
  type DrawingKind,
  type DrawingTarget,
  type UploadRefusedDetails,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock, IdGenerator } from '../../../common/clock.js';
import { storageKeys, type ObjectStorage } from '../../../common/object-storage.port.js';
import { discardObject } from '../../../common/storage/discard-object.js';
import { peekStream } from '../../../common/storage/peek-stream.js';
import type { CadFile } from '../domain/cad-file.js';
import type { CadTx, CadUnitOfWork } from '../domain/cad-file.repository.js';
import { isActive, nextOrdinal, type SiteDrawingRecord } from '../domain/site-drawing.js';
import { declaredFormat, SNIFF_BYTES, verifyCadContent } from '../domain/cad-sniffer.js';
import { discardRevisionInTx } from './discard-design-revision.use-case.js';
import { enqueueAfterCommit } from './cad-enqueue.js';
import type { JobQueue, WorkOrderSites } from './ports.js';

const refused = (
  code: 'NOT_FOUND' | 'CONFLICT',
  message: string,
  details: UploadRefusedDetails,
): AppError => new AppError(code, message, details);

/** The drawing a new version goes to: of that site and kind, linked and not withdrawn. */
function checkVersionTarget(
  drawing: SiteDrawingRecord | null,
  siteId: string,
  kind: DrawingKind,
  drawingId: string,
): SiteDrawingRecord {
  if (!drawing) throw new AppError('NOT_FOUND', 'Drawing not found');
  if (drawing.siteId === null || !isActive(drawing)) {
    throw refused('CONFLICT', 'The drawing is not linked to a site; link it first', {
      reason: 'DRAWING_UNASSIGNED',
      drawingId,
    });
  }
  if (drawing.siteId !== siteId || drawing.kind !== kind) {
    throw refused('CONFLICT', 'The drawing is not a drawing of this kind in this site', {
      reason: 'DRAWING_NOT_IN_SITE',
      drawingId,
      siteId,
    });
  }
  return drawing;
}

export class UploadCadFileUseCase {
  constructor(
    private readonly uow: CadUnitOfWork,
    private readonly storage: ObjectStorage,
    private readonly queue: JobQueue,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly maxBytes: number,
    private readonly sites: WorkOrderSites,
  ) {}

  async execute(input: {
    projectId: string;
    actorId: string;
    file: { fileName: string; stream: Readable };
    /** A site of the project's work order (ADR-049 part B). */
    siteId: string;
    /** General or Secondary (ADR-040). */
    kind: DrawingKind;
    /** A new drawing of the site, or a new version of `drawingId` (supersedes its current file). */
    target: DrawingTarget;
    drawingId?: string | undefined;
  }): Promise<CadFile> {
    const { projectId, actorId, file, siteId, kind } = input;
    const format = declaredFormat(file.fileName);
    const { head, stream } = await peekStream(file.stream, SNIFF_BYTES);
    verifyCadContent(format, head);

    const site = (await this.sites.listOfProject(projectId)).find((s) => s.id === siteId);
    if (!site) {
      throw refused('NOT_FOUND', 'The site is not on the work order of this project', {
        reason: 'SITE_NOT_FOUND',
        siteId,
      });
    }
    // Cheap pre-check so a refused upload never stores the file; the locked check below decides.
    await this.uow.run((tx) => this.resolveDrawing(tx, { ...input, lock: false }));

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
      drawingId: '',
      siteId,
      drawingOrdinal: 1,
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
        const { drawing, created, current } = await this.resolveDrawing(tx, {
          ...input,
          lock: true,
        });
        uploaded.drawingId = drawing.id;
        uploaded.drawingOrdinal = drawing.ordinal;
        if (created) {
          await tx.drawings.insert(drawing);
          await tx.events.append({
            projectId,
            entity: EVENT_ENTITIES.siteDrawing,
            entityId: drawing.id,
            type: EVENT_TYPES.siteDrawingCreated,
            actorId,
            payload: { siteId, kind, ordinal: drawing.ordinal },
          });
        }
        const supersededFileIds = current.map((f) => f.id);
        // A new version makes the open revision of the drawing (built from an older file) useless:
        // discard it, whatever its state, and supersede a worker still building it (owner, M1).
        let discardedRevisionId: string | null = null;
        if (current.length > 0) {
          const open = await tx.revisions.findOpen(projectId, drawing.id);
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
        // The older files are marked first: the new file is the only current one once inserted
        // (the foreign key to it is checked at commit).
        await tx.files.supersede(projectId, supersededFileIds, id, now);
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
            drawingKind: kind,
            drawingId: drawing.id,
            siteId,
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

  /**
   * The drawing the file goes to (ADR-049 part B). A new drawing: a General is refused when the site
   * has one (GENERAL_EXISTS); a Secondary gets the next number. A new version: the drawing's
   * current files (to supersede). `lock` serialises uploads of the site and of the drawing.
   */
  private async resolveDrawing(
    tx: CadTx,
    input: {
      projectId: string;
      actorId: string;
      siteId: string;
      kind: DrawingKind;
      target: DrawingTarget;
      drawingId?: string | undefined;
      lock: boolean;
    },
  ): Promise<{ drawing: SiteDrawingRecord; created: boolean; current: CadFile[] }> {
    const { projectId, siteId, kind, target, lock } = input;
    if (target === 'new_version') {
      const drawingId = input.drawingId ?? '';
      const drawing = checkVersionTarget(
        await tx.drawings.find(projectId, drawingId, { lock }),
        siteId,
        kind,
        drawingId,
      );
      const current = lock ? await tx.files.lockCurrentOfDrawing(projectId, drawing.id) : [];
      return { drawing, created: false, current };
    }
    if (lock) await tx.drawings.lockProject(projectId);
    const inSite = await tx.drawings.listOfSite(projectId, siteId, { lock });
    const general = inSite.find((d) => d.kind === 'general' && isActive(d));
    if (kind === 'general' && general) {
      const file = await tx.files.findCurrentOfDrawing(projectId, general.id);
      throw refused('CONFLICT', 'This site already has its General drawing', {
        reason: 'GENERAL_EXISTS',
        siteId,
        drawingId: general.id,
        currentFileName: file?.originalName ?? null,
      });
    }
    const drawing: SiteDrawingRecord = {
      id: this.ids.next(),
      projectId,
      siteId,
      kind,
      ordinal: nextOrdinal(inSite, kind),
      withdrawnAt: null,
      withdrawnById: null,
      createdById: input.actorId,
      createdAt: this.clock.now(),
    };
    return { drawing, created: true, current: [] };
  }

  private async reload(file: CadFile): Promise<CadFile> {
    const current = await this.uow.run((tx) => tx.files.find(file.projectId, file.id));
    return current ?? file;
  }
}
