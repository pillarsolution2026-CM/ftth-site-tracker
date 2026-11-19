import {
  DesignRevisionCountsSchema,
  DiffCountsSchema,
  TextLinkCountsSchema,
  BoxShapeGallerySchema,
  FrozenBoxTypesSchema,
  FrozenInstallationSchema,
  installationRouteOf,
  type InstallationRoute,
} from '@ftth/shared';
import { and, asc, desc, eq, inArray, isNull, max, sql } from 'drizzle-orm';
import { AppError } from '../../../common/app-error.js';
import { toDecimalText } from '../../../common/decimal-text.js';
import type { DbHandle } from '../../../db/db.module.js';
import { lockNotAvailable, uniqueViolation } from '../../../db/pg-errors.js';
import { cadFiles, designFeatures, designRevisions, siteDrawings } from '../../../db/schema.js';
import type { DesignRevision } from '../domain/design-revision.js';
import type {
  DesignRevisionRepository,
  NewDesignRevision,
  SubCabinetPosition,
} from '../domain/design-revision.repository.js';

const OPEN_INDEX = 'design_revisions_one_open_idx';
/**
 * The worker holds the revision row for the whole build. A request that needs the row waits at
 * most this long and then answers 409 REVISION_BUSY instead of hanging (security review M1).
 */
const LOCK_TIMEOUT = sql.raw(`SET LOCAL lock_timeout = '5s'`);

const columns = {
  row: designRevisions,
  cadFileName: cadFiles.originalName,
  siteId: siteDrawings.siteId,
  drawingOrdinal: siteDrawings.ordinal,
};

type Joined = {
  row: typeof designRevisions.$inferSelect;
  cadFileName: string;
  siteId: string | null;
  drawingOrdinal: number;
};

function toRevision({ row, cadFileName, siteId, drawingOrdinal }: Joined): DesignRevision {
  return {
    id: row.id,
    projectId: row.projectId,
    cadFileId: row.cadFileId,
    cadFileName,
    drawingKind: row.drawingKind,
    drawingId: row.drawingId,
    siteId,
    drawingOrdinal,
    revNo: row.revNo,
    status: row.status,
    currentJobId: row.currentJobId,
    baseRevisionId: row.baseRevisionId,
    rules: row.rules,
    mappingVersion: row.mappingVersion,
    crsEpsg: row.crsEpsg,
    drawingUnit: row.drawingUnit,
    metresPerUnit: toDecimalText(row.metresPerUnit),
    placement: row.placement ?? null,
    installation: FrozenInstallationSchema.safeParse(row.installation).data ?? null,
    boxTypes: FrozenBoxTypesSchema.safeParse(row.boxTypes).data ?? null,
    boxShapes: BoxShapeGallerySchema.safeParse(row.boxShapes).data ?? null,
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
      )
      .innerJoin(
        siteDrawings,
        and(
          eq(siteDrawings.projectId, designRevisions.projectId),
          eq(siteDrawings.id, designRevisions.drawingId),
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
      await this.db.execute(LOCK_TIMEOUT);
      try {
        await this.db
          .select({ id: designRevisions.id })
          .from(designRevisions)
          .where(inProject(projectId, revisionId))
          .for('update');
      } catch (error) {
        if (!lockNotAvailable(error)) throw error;
        throw new AppError('CONFLICT', 'The revision is being built; try again shortly', {
          reason: 'REVISION_BUSY',
        });
      }
    }
    const [row] = await this.selectJoined().where(inProject(projectId, revisionId));
    return row ? toRevision(row) : null;
  }

  async findLatestPublishedId(projectId: string, drawingId: string): Promise<string | null> {
    return (await this.findLatestPublished(projectId, drawingId))?.id ?? null;
  }

  async findLatestPublished(projectId: string, drawingId: string): Promise<DesignRevision | null> {
    const [row] = await this.selectJoined()
      .where(
        and(
          eq(designRevisions.projectId, projectId),
          eq(designRevisions.drawingId, drawingId),
          eq(designRevisions.status, 'published'),
        ),
      )
      .orderBy(desc(designRevisions.revNo))
      .limit(1);
    return row ? toRevision(row) : null;
  }

  async hasOpen(projectId: string, drawingId: string): Promise<boolean> {
    return (await this.findOpen(projectId, drawingId)) !== null;
  }

  async findOpen(projectId: string, drawingId: string): Promise<DesignRevision | null> {
    const [row] = await this.selectJoined()
      .where(
        and(
          eq(designRevisions.projectId, projectId),
          eq(designRevisions.drawingId, drawingId),
          inArray(designRevisions.status, ['queued', 'building', 'draft']),
        ),
      )
      .limit(1);
    return row ? toRevision(row) : null;
  }

  async siteGeneralCabinets(
    projectId: string,
    siteIds: string[],
  ): Promise<{ siteId: string; names: (string | null)[] }[]> {
    if (siteIds.length === 0) return [];
    // Per General: the open draft, else the latest published revision (never a queued/building one).
    const generals = await this.db
      .select({ id: siteDrawings.id, siteId: siteDrawings.siteId })
      .from(siteDrawings)
      .where(
        and(
          eq(siteDrawings.projectId, projectId),
          eq(siteDrawings.drawingKind, 'general'),
          isNull(siteDrawings.withdrawnAt),
          inArray(siteDrawings.siteId, siteIds),
        ),
      );
    const out: { siteId: string; names: (string | null)[] }[] = [];
    for (const general of generals) {
      if (general.siteId === null) continue;
      const [draft] = await this.db
        .select({ id: designRevisions.id })
        .from(designRevisions)
        .where(
          and(
            eq(designRevisions.projectId, projectId),
            eq(designRevisions.drawingId, general.id),
            eq(designRevisions.status, 'draft'),
          ),
        )
        .limit(1);
      const revisionId = draft?.id ?? (await this.findLatestPublishedId(projectId, general.id));
      if (revisionId === null) continue;
      out.push({
        siteId: general.siteId,
        names: await this.subCabinetCodes(projectId, revisionId),
      });
    }
    return out;
  }

  async subCabinetCodes(projectId: string, revisionId: string): Promise<(string | null)[]> {
    const rows = await this.db
      .select({ code: designFeatures.code })
      .from(designFeatures)
      .where(
        and(
          eq(designFeatures.projectId, projectId),
          eq(designFeatures.revisionId, revisionId),
          eq(designFeatures.featureType, 'cabinet'),
          sql`${designFeatures.attrs} ->> 'role' = 'sub'`,
        ),
      )
      .orderBy(designFeatures.sourceHandle, designFeatures.featureId);
    return rows.map((row) => row.code);
  }

  async installationRoutes(projectId: string, revisionId: string): Promise<InstallationRoute[]> {
    const rows = await this.db
      .select({
        id: designFeatures.featureId,
        featureType: designFeatures.featureType,
        sourceHandle: designFeatures.sourceHandle,
        attrs: designFeatures.attrs,
      })
      .from(designFeatures)
      .where(
        and(
          eq(designFeatures.projectId, projectId),
          eq(designFeatures.revisionId, revisionId),
          eq(designFeatures.featureType, 'route'),
        ),
      )
      .orderBy(designFeatures.sourceHandle, designFeatures.featureId);
    return rows.flatMap((row) => {
      const route = installationRouteOf({ ...row });
      return route ? [route] : [];
    });
  }

  async frozenMergeHandles(projectId: string, revisionId: string): Promise<string[][]> {
    const [row] = await this.db
      .select({ corrections: designRevisions.corrections })
      .from(designRevisions)
      .where(inProject(projectId, revisionId));
    return (row?.corrections ?? []).flatMap((frozen) =>
      frozen.correction.kind === 'merge_routes' ? [frozen.correction.handles] : [],
    );
  }

  async findLatestBuiltOfFile(
    projectId: string,
    cadFileId: string,
  ): Promise<DesignRevision | null> {
    const [row] = await this.selectJoined()
      .where(
        and(
          eq(designRevisions.projectId, projectId),
          eq(designRevisions.cadFileId, cadFileId),
          inArray(designRevisions.status, ['draft', 'published']),
        ),
      )
      .orderBy(desc(designRevisions.createdAt), desc(designRevisions.id))
      .limit(1);
    return row ? toRevision(row) : null;
  }

  async subCabinetPositions(
    projectId: string,
    revisionId: string,
    limit: number,
  ): Promise<SubCabinetPosition[]> {
    const rows = await this.db
      .select({
        code: designFeatures.code,
        sourceHandle: designFeatures.sourceHandle,
        x: sql<number>`ST_X(${designFeatures.geom})`,
        y: sql<number>`ST_Y(${designFeatures.geom})`,
        attrs: designFeatures.attrs,
      })
      .from(designFeatures)
      .where(
        and(
          eq(designFeatures.projectId, projectId),
          eq(designFeatures.revisionId, revisionId),
          eq(designFeatures.featureType, 'cabinet'),
          sql`${designFeatures.attrs} ->> 'role' = 'sub'`,
        ),
      )
      .orderBy(asc(designFeatures.sourceHandle), asc(designFeatures.featureId))
      .limit(limit);
    return rows;
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
        drawingKind: revision.drawingKind,
        drawingId: revision.drawingId,
        status: 'queued',
        currentJobId: revision.currentJobId,
        baseRevisionId: revision.baseRevisionId,
        rules: revision.rules,
        mappingVersion: revision.mappingVersion,
        crsEpsg: revision.crsEpsg,
        drawingUnit: revision.drawingUnit,
        metresPerUnit: revision.metresPerUnit,
        placement: revision.placement,
        corrections: revision.corrections,
        installation: revision.installation,
        boxTypes: revision.boxTypes,
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

  async publish(
    projectId: string,
    siteId: string,
    revisionIds: string[],
    actorId: string,
    at: Date,
  ): Promise<number> {
    // One site publication = one number shared by every revision it publishes: the highest number
    // over the revisions of the site's drawings + 1 (numbers of one drawing may skip).
    const [latest] = await this.db
      .select({ value: max(designRevisions.revNo) })
      .from(designRevisions)
      .innerJoin(
        siteDrawings,
        and(
          eq(siteDrawings.projectId, designRevisions.projectId),
          eq(siteDrawings.id, designRevisions.drawingId),
        ),
      )
      .where(and(eq(designRevisions.projectId, projectId), eq(siteDrawings.siteId, siteId)));
    const revNo = (latest?.value ?? 0) + 1;
    await this.db
      .update(designRevisions)
      .set({ status: 'published', revNo, publishedAt: at, publishedBy: actorId })
      .where(
        and(
          eq(designRevisions.projectId, projectId),
          inArray(designRevisions.id, revisionIds),
          eq(designRevisions.status, 'draft'),
        ),
      );
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
