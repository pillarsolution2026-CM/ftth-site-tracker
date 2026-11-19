import { and, asc, eq, inArray } from 'drizzle-orm';
import { AppError } from '../../../common/app-error.js';
import { restrictingConstraint } from '../../../db/pg-errors.js';
import type { DbHandle } from '../../../db/db.module.js';
import { workOrderSites } from '../../../db/schema.js';
import type { WorkOrderSiteRepository } from '../domain/work-order.repository.js';
import type { SiteReplacement, WorkOrderSite } from '../domain/work-order-site.js';

type SiteRow = typeof workOrderSites.$inferSelect;

const toSite = (row: SiteRow): WorkOrderSite => ({
  id: row.id,
  workOrderId: row.workOrderId,
  name: row.name,
  nameKey: row.nameKey,
  position: row.position,
  createdById: row.createdBy,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export class DrizzleWorkOrderSiteRepository implements WorkOrderSiteRepository {
  constructor(private readonly db: DbHandle) {}

  async list(projectId: string, workOrderId: string): Promise<WorkOrderSite[]> {
    const rows = await this.db
      .select()
      .from(workOrderSites)
      .where(
        and(eq(workOrderSites.projectId, projectId), eq(workOrderSites.workOrderId, workOrderId)),
      )
      .orderBy(asc(workOrderSites.position));
    return rows.map(toSite);
  }

  async listOfProject(projectId: string): Promise<WorkOrderSite[]> {
    const rows = await this.db
      .select()
      .from(workOrderSites)
      .where(eq(workOrderSites.projectId, projectId))
      .orderBy(asc(workOrderSites.workOrderId), asc(workOrderSites.position));
    return rows.map(toSite);
  }

  async apply(projectId: string, workOrderId: string, plan: SiteReplacement): Promise<void> {
    const scope = and(
      eq(workOrderSites.projectId, projectId),
      eq(workOrderSites.workOrderId, workOrderId),
    );
    if (plan.removed.length > 0) {
      try {
        await this.db.delete(workOrderSites).where(
          and(
            scope,
            inArray(
              workOrderSites.id,
              plan.removed.map((site) => site.id),
            ),
          ),
        );
      } catch (error) {
        // A site with drawings cannot be removed (ADR-049 part B: site_drawings is RESTRICT).
        if (restrictingConstraint(error) === 'site_drawings_site_fkey') {
          throw new AppError('CONFLICT', 'A site that has drawings cannot be removed', {
            reason: 'SITE_HAS_DRAWINGS',
          });
        }
        throw error;
      }
    }
    for (const site of plan.updated) {
      await this.db
        .update(workOrderSites)
        .set({
          name: site.name,
          nameKey: site.nameKey,
          position: site.position,
          updatedAt: site.updatedAt,
        })
        .where(and(scope, eq(workOrderSites.id, site.id)));
    }
    if (plan.inserted.length > 0) {
      await this.db.insert(workOrderSites).values(
        plan.inserted.map((site) => ({
          id: site.id,
          projectId,
          workOrderId,
          name: site.name,
          nameKey: site.nameKey,
          position: site.position,
          createdBy: site.createdById,
          createdAt: site.createdAt,
          updatedAt: site.updatedAt,
        })),
      );
    }
  }
}
