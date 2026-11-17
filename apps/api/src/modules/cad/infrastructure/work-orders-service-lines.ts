import type { FindWorkOrderLinesUseCase } from '../../work-orders/application/work-order-lines.js';
import type { WorkOrderLineRef, WorkOrderLines } from '../application/ports.js';

/** Reads the project's work-order lines through the work-orders module's exported service. */
export class WorkOrdersServiceLines implements WorkOrderLines {
  constructor(private readonly findLines: FindWorkOrderLinesUseCase) {}

  async findLinesOfProject(
    projectId: string,
  ): Promise<{ exists: boolean; lines: WorkOrderLineRef[] }> {
    return this.findLines.findLinesOfProject(projectId);
  }
}
