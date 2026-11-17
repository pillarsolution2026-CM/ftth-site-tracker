import { CrsDetectionSchema, type DrawingKind } from '@ftth/shared';
import { and, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import type { DbHandle } from '../../../db/db.module.js';
import { cadFiles, projects } from '../../../db/schema.js';
import type { CadFile, DrawingViewRecord } from '../domain/cad-file.js';
import type { CadFileRepository } from '../domain/cad-file.repository.js';

type Row = typeof cadFiles.$inferSelect;

function toCadFile(row: Row): CadFile {
  const hasExtents =
    row.extentsMinX !== null &&
    row.extentsMinY !== null &&
    row.extentsMaxX !== null &&
    row.extentsMaxY !== null;
  const hasCounts =
    row.layerCount !== null &&
    row.insertCount !== null &&
    row.textCount !== null &&
    row.curveCount !== null;
  return {
    id: row.id,
    projectId: row.projectId,
    originalName: row.originalName,
    format: row.format,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    storageKey: row.storageKey,
    convertedStorageKey: row.convertedStorageKey,
    status: row.status,
    drawingKind: row.drawingKind,
    supersededAt: row.supersededAt,
    supersededById: row.supersededBy,
    currentJobId: row.currentJobId,
    converter: row.converter,
    converterVersion: row.converterVersion,
    dxfVersion: row.dxfVersion,
    insUnits: row.insUnits,
    extents: hasExtents
      ? {
          minX: row.extentsMinX ?? 0,
          minY: row.extentsMinY ?? 0,
          maxX: row.extentsMaxX ?? 0,
          maxY: row.extentsMaxY ?? 0,
        }
      : null,
    // A value the contract does not recognise (newer worker) is treated as "no detection".
    crsDetection: CrsDetectionSchema.safeParse(row.crsDetection).data ?? null,
    counts: hasCounts
      ? {
          layers: row.layerCount ?? 0,
          inserts: row.insertCount ?? 0,
          texts: row.textCount ?? 0,
          curves: row.curveCount ?? 0,
        }
      : null,
    warnings: row.warnings,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    uploadedById: row.uploadedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    queuedAt: row.queuedAt,
    processingStartedAt: row.processingStartedAt,
    processedAt: row.processedAt,
  };
}

/** The drawing view back to "none": no job, no stored file. */
const NO_VIEW = {
  viewStatus: 'none' as const,
  viewJobId: null,
  viewStorageKey: null,
  viewSizeBytes: null,
  viewErrorCode: null,
  viewRenderedAt: null,
  viewQueuedAt: null,
};

const inProject = (projectId: string, cadFileId: string) =>
  and(eq(cadFiles.projectId, projectId), eq(cadFiles.id, cadFileId));

export class DrizzleCadFileRepository implements CadFileRepository {
  constructor(private readonly db: DbHandle) {}

  /** Current files only: older versions stay as history but are not listed (owner 2026-11-11). */
  async list(projectId: string): Promise<CadFile[]> {
    const rows = await this.db
      .select()
      .from(cadFiles)
      .where(and(eq(cadFiles.projectId, projectId), isNull(cadFiles.supersededAt)))
      .orderBy(desc(cadFiles.createdAt), desc(cadFiles.id));
    return rows.map(toCadFile);
  }

  async find(
    projectId: string,
    cadFileId: string,
    options?: { lock?: boolean },
  ): Promise<CadFile | null> {
    const query = this.db.select().from(cadFiles).where(inProject(projectId, cadFileId));
    const [row] = await (options?.lock ? query.for('update') : query);
    return row ? toCadFile(row) : null;
  }

  async insertUploaded(file: CadFile): Promise<void> {
    await this.db.insert(cadFiles).values({
      id: file.id,
      projectId: file.projectId,
      originalName: file.originalName,
      format: file.format,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
      storageKey: file.storageKey,
      status: 'uploaded',
      drawingKind: file.drawingKind,
      uploadedBy: file.uploadedById,
    });
  }

  async listCurrentOfKind(projectId: string, kind: DrawingKind): Promise<CadFile[]> {
    const rows = await this.db
      .select()
      .from(cadFiles)
      .where(
        and(
          eq(cadFiles.projectId, projectId),
          eq(cadFiles.drawingKind, kind),
          isNull(cadFiles.supersededAt),
        ),
      )
      .orderBy(desc(cadFiles.createdAt), desc(cadFiles.id));
    return rows.map(toCadFile);
  }

  async lockCurrentOfKind(projectId: string, kind: DrawingKind): Promise<CadFile[]> {
    // NO KEY UPDATE: serialises two first uploads without blocking children's foreign-key checks.
    await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .for('no key update');
    const rows = await this.db
      .select()
      .from(cadFiles)
      .where(
        and(
          eq(cadFiles.projectId, projectId),
          eq(cadFiles.drawingKind, kind),
          isNull(cadFiles.supersededAt),
        ),
      )
      .orderBy(desc(cadFiles.createdAt), desc(cadFiles.id))
      .for('update');
    return rows.map(toCadFile);
  }

  async supersede(projectId: string, fileIds: string[], byId: string, at: Date): Promise<void> {
    if (fileIds.length === 0) return;
    await this.db
      .update(cadFiles)
      .set({ supersededAt: at, supersededBy: byId })
      .where(
        and(
          eq(cadFiles.projectId, projectId),
          inArray(cadFiles.id, fileIds),
          isNull(cadFiles.supersededAt),
        ),
      );
  }

  async markQueued(projectId: string, cadFileId: string, jobId: string, at: Date): Promise<void> {
    await this.db
      .update(cadFiles)
      .set({
        status: 'queued',
        currentJobId: jobId,
        queuedAt: at,
        errorCode: null,
        errorMessage: null,
        // The rows (and handles) may change on a rerun, so the flattened drawing is stale (ADR-039).
        ...NO_VIEW,
      })
      .where(inProject(projectId, cadFileId));
  }

  async markEnqueueFailed(
    projectId: string,
    cadFileId: string,
    jobId: string,
    message: string,
  ): Promise<boolean> {
    const updated = await this.db
      .update(cadFiles)
      .set({ status: 'failed', errorCode: 'ENQUEUE_FAILED', errorMessage: message })
      .where(
        and(
          inProject(projectId, cadFileId),
          eq(cadFiles.currentJobId, jobId),
          eq(cadFiles.status, 'queued'),
        ),
      )
      .returning({ id: cadFiles.id });
    return updated.length > 0;
  }

  async findView(projectId: string, cadFileId: string): Promise<DrawingViewRecord | null> {
    const [row] = await this.db
      .select({
        id: cadFiles.id,
        status: cadFiles.viewStatus,
        jobId: cadFiles.viewJobId,
        storageKey: cadFiles.viewStorageKey,
        sizeBytes: cadFiles.viewSizeBytes,
        errorCode: cadFiles.viewErrorCode,
        renderedAt: cadFiles.viewRenderedAt,
        queuedAt: cadFiles.viewQueuedAt,
      })
      .from(cadFiles)
      .where(inProject(projectId, cadFileId));
    if (!row) return null;
    const { id, ...rest } = row;
    return { cadFileId: id, ...rest };
  }

  async markViewQueued(
    projectId: string,
    cadFileId: string,
    jobId: string,
    queuedAt: Date,
    staleBefore: Date,
  ): Promise<boolean> {
    const updated = await this.db
      .update(cadFiles)
      .set({ ...NO_VIEW, viewStatus: 'queued', viewJobId: jobId, viewQueuedAt: queuedAt })
      .where(
        and(
          inProject(projectId, cadFileId),
          or(
            inArray(cadFiles.viewStatus, ['none', 'failed']),
            and(eq(cadFiles.viewStatus, 'queued'), lt(cadFiles.viewQueuedAt, staleBefore)),
          ),
        ),
      )
      .returning({ id: cadFiles.id });
    return updated.length > 0;
  }

  async markViewEnqueueFailed(
    projectId: string,
    cadFileId: string,
    jobId: string,
  ): Promise<boolean> {
    const updated = await this.db
      .update(cadFiles)
      .set({ viewStatus: 'failed', viewErrorCode: 'QUEUE_UNAVAILABLE', viewQueuedAt: null })
      .where(
        and(
          inProject(projectId, cadFileId),
          eq(cadFiles.viewJobId, jobId),
          eq(cadFiles.viewStatus, 'queued'),
        ),
      )
      .returning({ id: cadFiles.id });
    return updated.length > 0;
  }

  async findLog(projectId: string, cadFileId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ log: cadFiles.log })
      .from(cadFiles)
      .where(inProject(projectId, cadFileId));
    return row?.log ?? null;
  }
}
