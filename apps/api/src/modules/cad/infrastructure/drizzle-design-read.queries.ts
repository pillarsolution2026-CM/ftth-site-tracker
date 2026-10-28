import type {
  DesignFeature,
  DesignFeatureListQuery,
  DesignFeaturePage,
  DiffItem,
  DiffListQuery,
  DiffPage,
  TextLink,
  TextLinkListQuery,
  TextLinkPage,
} from '@ftth/shared';
import { and, asc, count, eq, ilike, ne, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { toDecimalText, toDecimalTextOrNull } from '../../../common/decimal-text.js';
import type { DbHandle } from '../../../db/db.module.js';
import { designFeatures, revisionDiffItems, textLinks } from '../../../db/schema.js';
import type { DesignReadQueries } from '../domain/design-revision.repository.js';

/** `%`, `_` and `\` in user input must match themselves in ILIKE. */
const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (char) => `\\${char}`);

const linkedFeature = alias(designFeatures, 'linked_feature');

/**
 * Read side over the tables the CAD worker fills. Geometry leaves the database only as numbers
 * (ST_X/ST_Y in the revision CRS, metres). Every query carries `project_id`.
 */
export class DrizzleDesignReadQueries implements DesignReadQueries {
  constructor(private readonly db: DbHandle) {}

  async features(
    projectId: string,
    revisionId: string,
    query: DesignFeatureListQuery,
  ): Promise<DesignFeaturePage> {
    const conditions: SQL[] = [
      eq(designFeatures.projectId, projectId),
      eq(designFeatures.revisionId, revisionId),
    ];
    if (query.featureType) conditions.push(eq(designFeatures.featureType, query.featureType));
    if (query.q) {
      const pattern = `%${escapeLike(query.q)}%`;
      const match = or(
        ilike(designFeatures.code, pattern),
        ilike(designFeatures.sourceHandle, pattern),
      );
      if (match) conditions.push(match);
    }
    const where = and(...conditions);

    // A route's anchor is its first vertex; points are their own anchor.
    const anchor = sql`CASE WHEN ${designFeatures.featureType} = 'route'
      THEN ST_StartPoint(${designFeatures.geom}) ELSE ${designFeatures.geom} END`;
    const rows = await this.db
      .select({
        // Everything but the geometry itself, which can be large for routes.
        row: {
          featureId: designFeatures.featureId,
          revisionId: designFeatures.revisionId,
          featureType: designFeatures.featureType,
          code: designFeatures.code,
          layer: designFeatures.layer,
          blockName: designFeatures.blockName,
          sourceKind: designFeatures.sourceKind,
          sourceHandle: designFeatures.sourceHandle,
          lengthM: designFeatures.lengthM,
          attrs: designFeatures.attrs,
        },
        x: sql<number>`ST_X(${anchor})`,
        y: sql<number>`ST_Y(${anchor})`,
      })
      .from(designFeatures)
      .where(where)
      .orderBy(
        asc(designFeatures.featureType),
        asc(designFeatures.code),
        asc(designFeatures.sourceHandle),
        asc(designFeatures.featureId),
      )
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    const items: DesignFeature[] = rows.map(({ row, x, y }) => ({
      id: row.featureId,
      revisionId: row.revisionId,
      featureType: row.featureType,
      code: row.code,
      layer: row.layer,
      blockName: row.blockName,
      sourceKind: row.sourceKind,
      sourceHandle: row.sourceHandle,
      lengthM: toDecimalTextOrNull(row.lengthM),
      anchor: { x, y },
      attrs: row.attrs,
    }));
    const [total] = await this.db.select({ value: count() }).from(designFeatures).where(where);
    return { items, page: query.page, pageSize: query.pageSize, total: total?.value ?? 0 };
  }

  private linkSelect() {
    return this.db
      .select({
        link: textLinks,
        featureType: linkedFeature.featureType,
        featureCode: linkedFeature.code,
        x: sql<number>`ST_X(${textLinks.position})`,
        y: sql<number>`ST_Y(${textLinks.position})`,
      })
      .from(textLinks)
      .leftJoin(
        linkedFeature,
        and(
          eq(linkedFeature.revisionId, textLinks.revisionId),
          eq(linkedFeature.featureId, textLinks.featureId),
        ),
      );
  }

  async textLinks(
    projectId: string,
    revisionId: string,
    query: TextLinkListQuery,
  ): Promise<TextLinkPage> {
    const conditions: SQL[] = [
      eq(textLinks.projectId, projectId),
      eq(textLinks.revisionId, revisionId),
    ];
    if (query.status) conditions.push(eq(textLinks.status, query.status));
    if (query.kind) conditions.push(eq(textLinks.kind, query.kind));
    if (query.readable !== undefined) conditions.push(eq(textLinks.readable, query.readable));
    const where = and(...conditions);

    const rows = await this.linkSelect()
      .where(where)
      .orderBy(asc(textLinks.confidence), asc(textLinks.textHandle))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);
    const [total] = await this.db.select({ value: count() }).from(textLinks).where(where);
    return {
      items: rows.map(toTextLink),
      page: query.page,
      pageSize: query.pageSize,
      total: total?.value ?? 0,
    };
  }

  async textLink(projectId: string, revisionId: string, linkId: string): Promise<TextLink | null> {
    const [row] = await this.linkSelect().where(
      and(
        eq(textLinks.projectId, projectId),
        eq(textLinks.revisionId, revisionId),
        eq(textLinks.id, linkId),
      ),
    );
    return row ? toTextLink(row) : null;
  }

  async diff(projectId: string, revisionId: string, query: DiffListQuery): Promise<DiffPage> {
    const conditions: SQL[] = [
      eq(revisionDiffItems.projectId, projectId),
      eq(revisionDiffItems.revisionId, revisionId),
    ];
    if (query.change) {
      conditions.push(eq(revisionDiffItems.change, query.change));
    } else if (query.changedOnly !== false) {
      conditions.push(ne(revisionDiffItems.change, 'unchanged')); // default: changed items only
    }
    const where = and(...conditions);

    const rows = await this.db
      .select()
      .from(revisionDiffItems)
      .where(where)
      .orderBy(
        asc(revisionDiffItems.change),
        asc(revisionDiffItems.featureType),
        asc(revisionDiffItems.code),
        asc(revisionDiffItems.featureId),
      )
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);
    const items: DiffItem[] = rows.map((row) => ({
      id: row.id,
      featureId: row.featureId,
      featureType: row.featureType,
      change: row.change,
      code: row.code,
      previousCode: row.previousCode,
      distanceM: toDecimalTextOrNull(row.distanceM),
      lengthDeltaM: toDecimalTextOrNull(row.lengthDeltaM),
      candidateFeatureIds: row.candidateFeatureIds,
    }));
    const [total] = await this.db.select({ value: count() }).from(revisionDiffItems).where(where);
    return { items, page: query.page, pageSize: query.pageSize, total: total?.value ?? 0 };
  }
}

function toTextLink(row: {
  link: typeof textLinks.$inferSelect;
  featureType: TextLink['featureType'] | null;
  featureCode: string | null;
  x: number;
  y: number;
}): TextLink {
  const { link } = row;
  return {
    id: link.id,
    revisionId: link.revisionId,
    textHandle: link.textHandle,
    layer: link.layer,
    text: link.text,
    rawText: link.rawText,
    readable: link.readable,
    kind: link.kind,
    status: link.status,
    featureId: link.featureId,
    featureType: row.featureType,
    featureCode: row.featureCode,
    distanceM: toDecimalTextOrNull(link.distanceM),
    confidence: toDecimalText(link.confidence),
    position: { x: row.x, y: row.y },
    reviewedById: link.reviewedBy,
    reviewedAt: link.reviewedAt?.toISOString() ?? null,
  };
}
