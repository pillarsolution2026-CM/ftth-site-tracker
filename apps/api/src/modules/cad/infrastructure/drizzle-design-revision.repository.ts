import { DesignRevisionCountsSchema, DiffCountsSchema, TextLinkCountsSchema } from '@ftth/shared';
import { and, desc, eq, inArray, max } from 'drizzle-orm';
import { AppError } from '../../../common/app-error.js';
import { toDecimalText } from '../../../common/decimal-text.js';
import type { DbHandle } from '../../../db/db.module.js';
import { uniqueViolation } from '../../../db/pg-errors.js';
import { cadFiles, designRevisions } from '../../../db/schema.js';
import type { DesignRevision } from '../domain/design-revision.js';
import type {
  DesignRevisionRepository,
  NewDesignRevision,
} from '../domain/design-revision.repository.js';

const OPEN_INDEX = 'design_revisions_one_open_idx';

const columns = {
  row: designRevisions,
  cadFileName: cadFiles.originalName,
};

type Joined = { row: typeof designRevisions.$inferSelect; cadFileName: string };

function toRevision({ row, cadFileName }: Joined): DesignRevision {
  return {
    id: row.id,
    projectId: row.projectId,
    cadFileId: row.cadFileId,
    cadFileName,
    revNo: row.revNo,
    status: row.status,
    currentJobId: row.currentJobId,
    baseRevisionId: row.baseRevisionId,
    rules: row.rules,
    mappingVersion: row.mappingVersion,
    crsEpsg: row.crsEpsg,
    drawingUnit: row.drawingUnit,
    metresPerUnit: toDecimalText(row.metresPerUnit),
    insUnits: row.insUnits,
    unitsConflict: row.unitsConflict,
    // JSON written by the worker; a shape this contract does not know is shown as "not available".
    counts: DesignRevisionCountsSchema.safeParse(row.counts).data ?? null,
    textLinkCounts: TextLinkCountsSchema.safeParse(row.textLinkCounts).data ?? null,
    diffCounts: DiffCountsSchema.safeParse(row.diffCounts).data ?? null,
    tilesStorageKey: row.tilesStorageKey,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    log: row.log,
    createdById: row.createdBy,
    createdAt: row.createdAt,
    queuedAt: row.queuedAt,
    buildStartedAt: row.buildStartedAt,
    builtAt: row.builtAt,
    publishedAt: row.publishedAt,
    publishedById: row.publishedBy,
  };
}

const inProject = (projectId: string, revisionId: string) =>
  and(eq(designRevisions.projectId, projectId), eq(designRevisions.id, revisionId));

export class DrizzleDesignRevisionRepository implements DesignRevisionRepository {
  constructor(private readonly db: DbHandle) {}

  private selectJoined() {
    return this.db
      .select(columns)
      .from(designRevisions)
      .innerJoin(
        cadFiles,
        and(
          eq(cadFiles.projectId, designRevisions.projectId),
          eq(cadFiles.id, designRevisions.cadFileId),
        ),
      );
  }

  async list(projectId: string): Promise<DesignRevision[]> {
    const rows = await this.selectJoined()
      .where(eq(designRevisions.projectId, projectId))
      .orderBy(desc(designRevisions.createdAt), desc(designRevisions.id));
    return rows.map(toRevision);
  }

  async find(
    projectId: string,
    revisionId: string,
    options?: { lock?: boolean },
  ): Promise<DesignRevision | null> {
    if (options?.lock) {
      // FOR UPDATE cannot lock the nullable side of a join; lock the revision row on its own.
      await this.db
        .select({ id: designRevisions.id })
        .from(designRevisions)
        .where(inProject(projectId, revisionId))
        .for('update');
    }
    const [row] = await this.selectJoined().where(inProject(projectId, revisionId));
    return row ? toRevision(row) : null;
  }

  async findLatestPublishedId(projectId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ id: designRevisions.id })
      .from(designRevisions)
      .where(and(eq(designRevisions.projectId, projectId), eq(designRevisions.status, 'published')))
      .orderBy(desc(designRevisions.revNo))
      .limit(1);
    return row?.id ?? null;
  }

  async hasOpen(projectId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: designRevisions.id })
      .from(designRevisions)
      .where(
        and(
          eq(designRevisions.projectId, projectId),
          inArray(designRevisions.status, ['queued', 'building', 'draft']),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async hasInProgressForFile(projectId: string, cadFileId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: designRevisions.id })
      .from(designRevisions)
      .where(
        and(
          eq(designRevisions.projectId, projectId),
          eq(designRevisions.cadFileId, cadFileId),
          inArray(designRevisions.status, ['queued', 'building']),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async insert(revision: NewDesignRevision): Promise<void> {
    try {
      await this.db.insert(designRevisions).values({
        id: revision.id,
        projectId: revision.projectId,
        cadFileId: revision.cadFileId,
        status: 'queued',
        currentJobId: revision.currentJobId,
        baseRevisionId: revision.baseRevisionId,
        rules: revision.rules,
        mappingVersion: revision.mappingVersion,
        crsEpsg: revision.crsEpsg,
        drawingUnit: revision.drawingUnit,
        metresPerUnit: revision.metresPerUnit,
        insUnits: revision.insUnits,
        unitsConflict: revision.unitsConflict,
        createdBy: revision.createdById,
        queuedAt: revision.queuedAt,
      });
    } catch (error) {
      // Two creators racing past the pre-check: the partial unique index lets only one through.
      if (uniqueViolation(error) === OPEN_INDEX) {
        throw new AppError('CONFLICT', 'The project already has an open design revision', {
          reason: 'REVISION_IN_PROGRESS',
        });
      }
      throw error;
    }
  }

  async markEnqueueFailed(
    projectId: string,
    revisionId: string,
    jobId: string,
    message: string,
  ): Promise<boolean> {
    const updated = await this.db
      .update(designRevisions)
      .set({ status: 'failed', errorCode: 'ENQUEUE_FAILED', errorMessage: message })
      .where(
        and(
          inProject(projectId, revisionId),
          eq(designRevisions.currentJobId, jobId),
          eq(designRevisions.status, 'queued'),
        ),
      )
      .returning({ id: designRevisions.id });
    return updated.length > 0;
  }

  async publish(projectId: string, revisionId: string, actorId: string, at: Date): Promise<number> {
    const [latest] = await this.db
      .select({ value: max(designRevisions.revNo) })
      .from(designRevisions)
      .where(eq(designRevisions.projectId, projectId));
    const revNo = (latest?.value ?? 0) + 1;
    await this.db
      .update(designRevisions)
      .set({ status: 'published', revNo, publishedAt: at, publishedBy: actorId })
      .where(and(inProject(projectId, revisionId), eq(designRevisions.status, 'draft')));
    return revNo;
  }

  async discard(projectId: string, revisionId: string, supersedingJobId: string): Promise<void> {
    await this.db
      .update(designRevisions)
      .set({
        status: 'discarded',
        currentJobId: supersedingJobId,
        // `failed` is the only status that carries an error code (table CHECK); the event keeps it.
        errorCode: null,
      })
      .where(inProject(projectId, revisionId));
  }
}
