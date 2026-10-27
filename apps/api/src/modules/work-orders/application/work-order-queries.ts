import { AppError } from '../../../common/app-error.js';
import type {
  WorkOrderAttachment,
  WorkOrderAttachmentRepository,
  WorkOrderRepository,
  WorkOrderSummary,
} from '../domain/work-order.repository.js';
import type { WorkOrder } from '../domain/work-order.js';

export interface WorkOrderView {
  order: WorkOrder;
  attachments: WorkOrderAttachment[];
}

export class ListWorkOrdersUseCase {
  constructor(private readonly orders: WorkOrderRepository) {}

  execute(projectId: string): Promise<WorkOrderSummary[]> {
    return this.orders.listSummaries(projectId);
  }
}

export class GetWorkOrderUseCase {
  constructor(
    private readonly orders: WorkOrderRepository,
    private readonly attachments: WorkOrderAttachmentRepository,
  ) {}

  async execute(projectId: string, workOrderId: string): Promise<WorkOrderView> {
    const order = await this.orders.findById(projectId, workOrderId);
    if (!order) throw new AppError('NOT_FOUND', 'Work order not found');
    return { order, attachments: await this.attachments.listByWorkOrder(projectId, workOrderId) };
  }
}
