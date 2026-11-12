import type { WorkOrderRepository } from '../domain/work-order.repository.js';

/** One line of a project's work order as other modules see it. */
export interface WorkOrderLineView {
  id: string;
  code: string;
  description: string;
}

/**
 * Exported application service: the lines of the project's work order and whether it exists. The
 * cad module reads it for box types (ADR-043) and never touches this module's tables.
 */
export class FindWorkOrderLinesUseCase {
  constructor(private readonly orders: WorkOrderRepository) {}

  findLinesOfProject(projectId: string): Promise<{ exists: boolean; lines: WorkOrderLineView[] }> {
    return this.orders.findLinesOfProject(projectId);
  }
}
