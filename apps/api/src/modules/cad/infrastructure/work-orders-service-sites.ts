import type { FindWorkOrderSitesUseCase } from '../../work-orders/application/work-order-sites-port.js';
import type { WorkOrderSiteRef, WorkOrderSites } from '../application/ports.js';

/** Reads the project's sites through the work-orders module's exported service. */
export class WorkOrdersServiceSites implements WorkOrderSites {
  constructor(private readonly findSites: FindWorkOrderSitesUseCase) {}

  listOfProject(projectId: string): Promise<WorkOrderSiteRef[]> {
    return this.findSites.listOfProject(projectId);
  }
}
