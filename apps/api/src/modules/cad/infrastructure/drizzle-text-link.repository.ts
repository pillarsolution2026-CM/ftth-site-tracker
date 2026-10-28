import { TEXT_LINK_STATUSES, type TextLinkCounts } from '@ftth/shared';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import type { DbHandle } from '../../../db/db.module.js';
import {
  designFeatures,
  designRevisions,
  revisionDiffItems,
  textLinks,
} from '../../../db/schema.js';
import type {
  OpenItems,
  TextLinkRecord,
  TextLinkRepository,
} from '../domain/design-revision.repository.js';

const inRevision = (projectId: string, revisionId: string) =>
  and(eq(textLinks.projectId, projectId), eq(textLinks.revisionId, revisionId));

/**
 * Review writes on `text_links` and the derived `design_features.code` / revision counts. The
 * triggers of migration 0005 refuse all of it once the revision is published or discarded.
 */
export class DrizzleTextLinkRepository implements TextLinkRepository {
  constructor(private readonly db: DbHandle) {}

  async find(
    projectId: string,
    revisionId: string,
    linkId: string,
    options?: { lock?: boolean },
  ): Promise<TextLinkRecord | null> {
    const query = this.db
      .select({
        id: textLinks.id,
        revisionId: textLinks.revisionId,
        kind: textLinks.kind,
        status: textLinks.status,
        featureId: textLinks.featureId,
      })
      .from(textLinks)
      .where(and(inRevision(projectId, revisionId), eq(textLinks.id, linkId)));
    const [row] = await (options?.lock ? query.for('update') : query);
    return row ?? null;
  }

  async findFeature(
    projectId: string,
    revisionId: string,
    featureId: string,
  ): Promise<{ id: string; featureType: 'route' | 'box' | 'hhi' | 'joint' | 'mh' } | null> {
    const [row] = await this.db
      .select({ id: designFeatures.featureId, featureType: designFeatures.featureType })
      .from(designFeatures)
      .where(
        and(
          eq(designFeatures.projectId, projectId),
          eq(designFeatures.revisionId, revisionId),
          eq(designFeatures.featureId, featureId),
        ),
      );
    return row ?? null;
  }

  async confirm(
    projectId: string,
    revisionId: string,
    linkId: string,
    featureId: string,
    actorId: string,
    at: Date,
  ): Promise<void> {
    // Distance is recomputed from the stored geometries (revision CRS, metres), never trusted from a client.
    await this.db.execute(sql`
      UPDATE text_links AS l
         SET status = 'confirmed',
             feature_id = f.feature_id,
             distance_m = ST_Distance(l.position, f.geom)::numeric(12, 3),
             reviewed_by = ${actorId}::uuid,
             reviewed_at = ${at.toISOString()}::timestamptz
        FROM design_features AS f
       WHERE l.id = ${linkId}::uuid
         AND l.project_id = ${projectId}::uuid
         AND l.revision_id = ${revisionId}::uuid
         AND f.project_id = l.project_id
         AND f.revision_id = l.revision_id
         AND f.feature_id = ${featureId}::uuid`);
  }

  async reject(
    projectId: string,
    revisionId: string,
    linkId: string,
    actorId: string,
    at: Date,
  ): Promise<void> {
    await this.db
      .update(textLinks)
      .set({ status: 'rejected', reviewedBy: actorId, reviewedAt: at })
      .where(and(inRevision(projectId, revisionId), eq(textLinks.id, linkId)));
  }

  async recomputeBoxCodes(
    projectId: string,
    revisionId: string,
    featureIds: string[],
  ): Promise<void> {
    if (featureIds.length === 0) return;
    await this.db
      .update(designFeatures)
      .set({
        code: sql`(
          SELECT btrim(l.text)
            FROM text_links AS l
           WHERE l.revision_id = ${designFeatures.revisionId}
             AND l.feature_id = ${designFeatures.featureId}
             AND l.kind = 'box_id'
             AND l.status IN ('auto', 'confirmed')
             AND l.text IS NOT NULL
           ORDER BY l.confidence DESC, l.distance_m ASC, l.text_handle ASC
           LIMIT 1)`,
      })
      .where(
        and(
          eq(designFeatures.projectId, projectId),
          eq(designFeatures.revisionId, revisionId),
          eq(designFeatures.featureType, 'box'),
          inArray(designFeatures.featureId, featureIds),
        ),
      );
  }

  async recomputeCounts(projectId: string, revisionId: string): Promise<TextLinkCounts> {
    const rows = await this.db
      .select({ status: textLinks.status, total: count() })
      .from(textLinks)
      .where(inRevision(projectId, revisionId))
      .groupBy(textLinks.status);
    const counts = Object.fromEntries(
      TEXT_LINK_STATUSES.map((status) => [
        status,
        rows.find((row) => row.status === status)?.total ?? 0,
      ]),
    ) as TextLinkCounts;
    await this.db
      .update(designRevisions)
      .set({ textLinkCounts: counts })
      .where(and(eq(designRevisions.projectId, projectId), eq(designRevisions.id, revisionId)));
    return counts;
  }

  async countOpenItems(projectId: string, revisionId: string): Promise<OpenItems> {
    const [links] = await this.db
      .select({ total: count() })
      .from(textLinks)
      .where(and(inRevision(projectId, revisionId), eq(textLinks.status, 'review')));
    const [conflicts] = await this.db
      .select({ total: count() })
      .from(revisionDiffItems)
      .where(
        and(
          eq(revisionDiffItems.projectId, projectId),
          eq(revisionDiffItems.revisionId, revisionId),
          eq(revisionDiffItems.change, 'conflict'),
        ),
      );
    return { textLinksToReview: links?.total ?? 0, diffConflicts: conflicts?.total ?? 0 };
  }
}
