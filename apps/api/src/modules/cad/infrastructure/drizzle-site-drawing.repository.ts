import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { AppError } from '../../../common/app-error.js';
import type { DbHandle } from '../../../db/db.module.js';
import { restrictViolation } from '../../../db/pg-errors.js';
import { cadFiles, designRevisions, projects, siteDrawings } from '../../../db/schema.js';
import type { SiteDrawingRecord, SiteDrawingState } from '../domain/site-drawing.js';
import { sortDrawings } from '../domain/site-drawing.js';
import type { SiteDrawingRepository } from '../domain/site-drawing.repository.js';

type Row = typeof siteDrawings.$inferSelect;

const toRecord = (row: Row): SiteDrawingRecord => ({
  id: row.id,
  projectId: row.projectId,
  siteId: row.siteId,
  kind: row.drawingKind,
  ordinal: row.ordinal,
  withdrawnAt: row.withdrawnAt,
  withdrawnById: row.withdrawnBy,
  createdById: row.createdBy,
  createdAt: row.createdAt,
});

const inProject = (projectId: string, drawingId: string) =>
  and(eq(siteDrawings.projectId, projectId), eq(siteDrawings.id, drawingId));

export class DrizzleSiteDrawingRepository implements SiteDrawingRepository {
  constructor(private readonly db: DbHandle) {}

  async find(
    projectId: string,
    drawingId: string,
    options?: { lock?: boolean },
  ): Promise<SiteDrawingRecord | null> {
    const query = this.db.select().from(siteDrawings).where(inProject(projectId, drawingId));
    const [row] = await (options?.lock ? query.for('update') : query);
    return row ? toRecord(row) : null;
  }

  async listOfSite(
    projectId: string,
    siteId: string,
    options?: { lock?: boolean },
  ): Promise<SiteDrawingRecord[]> {
    const query = this.db
      .select()
      .from(siteDrawings)
      .where(and(eq(siteDrawings.projectId, projectId), eq(siteDrawings.siteId, siteId)))
      .orderBy(asc(siteDrawings.id));
    const rows = await (options?.lock ? query.for('update') : query);
    return sortDrawings(rows.map(toRecord));
  }

  async lockProject(projectId: string): Promise<void> {
    // NO KEY UPDATE: serialises two first uploads without blocking children's foreign-key checks.
    await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .for('no key update');
  }

  async listWithState(projectId: string): Promise<SiteDrawingState[]> {
    const rows = await this.db
      .select()
      .from(siteDrawings)
      .where(and(eq(siteDrawings.projectId, projectId), isNull(siteDrawings.withdrawnAt)))
      .orderBy(asc(siteDrawings.createdAt), asc(siteDrawings.id));
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const files = await this.db
      .select({ id: cadFiles.id, name: cadFiles.originalName, drawingId: cadFiles.drawingId })
      .from(cadFiles)
      .where(
        and(
          eq(cadFiles.projectId, projectId),
          inArray(cadFiles.drawingId, ids),
          isNull(cadFiles.supersededAt),
        ),
      );
    const revisions = await this.db
      .select({
        id: designRevisions.id,
        drawingId: designRevisions.drawingId,
        status: designRevisions.status,
        revNo: designRevisions.revNo,
        publishedAt: designRevisions.publishedAt,
      })
      .from(designRevisions)
      .where(
        and(
          eq(designRevisions.projectId, projectId),
          inArray(designRevisions.drawingId, ids),
          inArray(designRevisions.status, ['queued', 'building', 'draft', 'published']),
        ),
      )
      .orderBy(desc(designRevisions.revNo));
    return rows.map((row) => {
      const file = files.find((f) => f.drawingId === row.id);
      const open = revisions.find(
        (r) => r.drawingId === row.id && ['queued', 'building', 'draft'].includes(r.status),
      );
      const published = revisions.find((r) => r.drawingId === row.id && r.status === 'published');
      return {
        ...toRecord(row),
        currentFile: file ? { id: file.id, originalName: file.name } : null,
        openRevision: open
          ? { id: open.id, status: open.status as 'queued' | 'building' | 'draft' }
          : null,
        latestPublished:
          published?.revNo != null && published.publishedAt
            ? { id: published.id, revNo: published.revNo, publishedAt: published.publishedAt }
            : null,
      };
    });
  }

  async insert(drawing: SiteDrawingRecord): Promise<void> {
    await this.db.insert(siteDrawings).values({
      id: drawing.id,
      projectId: drawing.projectId,
      siteId: drawing.siteId,
      drawingKind: drawing.kind,
      ordinal: drawing.ordinal,
      createdBy: drawing.createdById,
      createdAt: drawing.createdAt,
    });
  }

  async assignSite(
    projectId: string,
    drawingId: string,
    siteId: string,
    ordinal: number,
  ): Promise<void> {
    await this.db
      .update(siteDrawings)
      .set({ siteId, ordinal })
      .where(and(inProject(projectId, drawingId), isNull(siteDrawings.siteId)));
  }

  async withdraw(projectId: string, drawingId: string, actorId: string, at: Date): Promise<void> {
    try {
      await this.db
        .update(siteDrawings)
        .set({ withdrawnAt: at, withdrawnBy: actorId })
        .where(and(inProject(projectId, drawingId), isNull(siteDrawings.withdrawnAt)));
    } catch (error) {
      if (restrictViolation(error)) {
        throw new AppError('CONFLICT', 'A published drawing cannot be withdrawn', {
          reason: 'DRAWING_PUBLISHED',
        });
      }
      throw error;
    }
  }
}
