import { and, desc, eq } from 'drizzle-orm';
import type { DbHandle } from '../../../db/db.module.js';
import { cadFiles } from '../../../db/schema.js';
import type { CadFile } from '../domain/cad-file.js';
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

const inProject = (projectId: string, cadFileId: string) =>
  and(eq(cadFiles.projectId, projectId), eq(cadFiles.id, cadFileId));

export class DrizzleCadFileRepository implements CadFileRepository {
  constructor(private readonly db: DbHandle) {}

  async list(projectId: string): Promise<CadFile[]> {
    const rows = await this.db
      .select()
      .from(cadFiles)
      .where(eq(cadFiles.projectId, projectId))
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
      uploadedBy: file.uploadedById,
    });
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

  async findLog(projectId: string, cadFileId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ log: cadFiles.log })
      .from(cadFiles)
      .where(inProject(projectId, cadFileId));
    return row?.log ?? null;
  }
}
