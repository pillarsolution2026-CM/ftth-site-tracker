import type { SupervisorSitesSite, SupervisorWithSites } from '@ftth/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Database, DbHandle } from '../../../db/db.module.js';
import { DrizzleEventLog } from '../../../db/drizzle-event-log.js';
import {
  assignments,
  supervisorSites,
  users,
  workOrderSites,
  workOrders,
} from '../../../db/schema.js';
import type {
  SupervisorSitesRepository,
  SupervisorSitesTx,
  SupervisorSitesUnitOfWork,
} from '../domain/supervisor-sites.js';

export class DrizzleSupervisorSitesRepository implements SupervisorSitesRepository {
  constructor(private readonly db: DbHandle) {}

  // The sites are written by the work-orders module; here they are only read.
  async listSites(projectId: string): Promise<SupervisorSitesSite[]> {
    return this.db
      .select({
        siteId: workOrderSites.id,
        name: workOrderSites.name,
        workOrderId: workOrderSites.workOrderId,
        workOrderNumber: workOrders.number,
      })
      .from(workOrderSites)
      .innerJoin(
        workOrders,
        and(
          eq(workOrders.projectId, workOrderSites.projectId),
          eq(workOrders.id, workOrderSites.workOrderId),
        ),
      )
      .where(eq(workOrderSites.projectId, projectId))
      .orderBy(asc(workOrders.number), asc(workOrderSites.position), asc(workOrderSites.id));
  }

  listSupervisors(projectId: string): Promise<SupervisorWithSites[]> {
    return this.supervisors(projectId, undefined);
  }

  async findSupervisor(projectId: string, userId: string): Promise<SupervisorWithSites | null> {
    const [found] = await this.supervisors(projectId, userId);
    return found ?? null;
  }

  async existingSiteIds(projectId: string, siteIds: readonly string[]): Promise<string[]> {
    if (siteIds.length === 0) return [];
    const rows = await this.db
      .select({ id: workOrderSites.id })
      .from(workOrderSites)
      .where(
        and(eq(workOrderSites.projectId, projectId), inArray(workOrderSites.id, [...siteIds])),
      );
    return rows.map((row) => row.id);
  }

  async replace(
    projectId: string,
    userId: string,
    siteIds: readonly string[],
    actorId: string,
  ): Promise<void> {
    await this.db
      .delete(supervisorSites)
      .where(and(eq(supervisorSites.projectId, projectId), eq(supervisorSites.userId, userId)));
    if (siteIds.length === 0) return;
    await this.db
      .insert(supervisorSites)
      .values(siteIds.map((siteId) => ({ projectId, userId, siteId, createdBy: actorId })));
  }

  private async supervisors(
    projectId: string,
    userId: string | undefined,
  ): Promise<SupervisorWithSites[]> {
    // A user may hold the supervisor role more than once (old zone rows): one entry per user.
    const people = await this.db
      .selectDistinct({
        userId: users.id,
        displayName: users.displayName,
        email: users.email,
        isActive: users.isActive,
      })
      .from(assignments)
      .innerJoin(users, eq(users.id, assignments.userId))
      .where(
        and(
          eq(assignments.projectId, projectId),
          eq(assignments.role, 'supervisor'),
          userId ? eq(assignments.userId, userId) : undefined,
        ),
      )
      .orderBy(asc(users.displayName), asc(users.email), asc(users.id));
    if (people.length === 0) return [];
    const held = await this.db
      .select({ userId: supervisorSites.userId, siteId: supervisorSites.siteId })
      .from(supervisorSites)
      .innerJoin(
        workOrderSites,
        and(
          eq(workOrderSites.projectId, supervisorSites.projectId),
          eq(workOrderSites.id, supervisorSites.siteId),
        ),
      )
      .innerJoin(
        workOrders,
        and(
          eq(workOrders.projectId, workOrderSites.projectId),
          eq(workOrders.id, workOrderSites.workOrderId),
        ),
      )
      .where(
        and(
          eq(supervisorSites.projectId, projectId),
          userId ? eq(supervisorSites.userId, userId) : undefined,
        ),
      )
      .orderBy(asc(workOrders.number), asc(workOrderSites.position), asc(workOrderSites.id));
    return people.map((person) => ({
      ...person,
      siteIds: held.filter((row) => row.userId === person.userId).map((row) => row.siteId),
    }));
  }
}

/** One database transaction: the repository and the event log share it. */
export class DrizzleSupervisorSitesUnitOfWork implements SupervisorSitesUnitOfWork {
  constructor(private readonly db: Database) {}

  run<T>(work: (tx: SupervisorSitesTx) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) =>
      work({ sites: new DrizzleSupervisorSitesRepository(tx), events: new DrizzleEventLog(tx) }),
    );
  }
}
