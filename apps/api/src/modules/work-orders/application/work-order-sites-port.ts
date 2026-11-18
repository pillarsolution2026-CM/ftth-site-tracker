import type { WorkOrderSiteRepository } from '../domain/work-order.repository.js';

/** One site of a work order as other modules see it (ADR-049 part B). */
export interface WorkOrderSiteView {
  id: string;
  workOrderId: string;
  name: string;
  position: number;
}

/**
 * Exported application service: the sites of the project's work order, in list order. The cad
 * module reads it for drawings per site and never touches this module's tables. A project has at
 * most one work order (`work_orders_one_per_project`).
 */
export class FindWorkOrderSitesUseCase {
  constructor(private readonly sites: WorkOrderSiteRepository) {}

  async listOfProject(projectId: string): Promise<WorkOrderSiteView[]> {
    const sites = await this.sites.listOfProject(projectId);
    return sites.map((site) => ({
      id: site.id,
      workOrderId: site.workOrderId,
      name: site.name,
      position: site.position,
    }));
  }

  async find(projectId: string, siteId: string): Promise<WorkOrderSiteView | null> {
    const sites = await this.listOfProject(projectId);
    return sites.find((site) => site.id === siteId) ?? null;
  }
}
