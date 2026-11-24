import type { SupervisorSitesSite, SupervisorWithSites } from '@ftth/shared';
import type { EventLog } from '../../../common/event-log.port.js';

/**
 * A supervisor's sites (ADR-054). Owned by identity because it is part of what a membership may
 * reach; the site list itself belongs to the work-orders module and is only read here.
 */
export interface SupervisorSitesRepository {
  /** Every site of the project's work orders: work order number, then site position. */
  listSites(projectId: string): Promise<SupervisorSitesSite[]>;
  /** Every user holding a supervisor assignment in the project, with his sites in `listSites` order. */
  listSupervisors(projectId: string): Promise<SupervisorWithSites[]>;
  /**
   * Locks the user's supervisor assignment rows in the project (SELECT ... FOR UPDATE) so a
   * concurrent removal of the assignment cannot interleave with replacing his sites.
   */
  lockSupervisorAssignments(projectId: string, userId: string): Promise<void>;
  /** The supervisor, or null when he has no supervisor assignment in the project. */
  findSupervisor(projectId: string, userId: string): Promise<SupervisorWithSites | null>;
  /** Which of `siteIds` are sites of the project (unknown or foreign ids are left out). */
  existingSiteIds(projectId: string, siteIds: readonly string[]): Promise<string[]>;
  /** Replaces the supervisor's sites in the project (empty = none). */
  replace(
    projectId: string,
    userId: string,
    siteIds: readonly string[],
    actorId: string,
  ): Promise<void>;
}

export interface SupervisorSitesTx {
  sites: SupervisorSitesRepository;
  events: EventLog;
}

/** The change and its event commit in one transaction. */
export interface SupervisorSitesUnitOfWork {
  run<T>(work: (tx: SupervisorSitesTx) => Promise<T>): Promise<T>;
}
