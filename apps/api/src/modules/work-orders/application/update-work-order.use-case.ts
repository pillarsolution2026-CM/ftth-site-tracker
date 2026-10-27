import { EVENT_ENTITIES, EVENT_TYPES, type UpdateWorkOrderRequest } from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import { WorkOrder, type HeaderPatch } from '../domain/work-order.js';
import type { WorkOrderUnitOfWork } from '../domain/work-order.repository.js';
import { diffFields } from './snapshots.js';
import type { WorkOrderView } from './work-order-queries.js';

export class UpdateWorkOrderUseCase {
  constructor(private readonly uow: WorkOrderUnitOfWork) {}

  async execute(input: {
    projectId: string;
    workOrderId: string;
    actorId: string;
    request: UpdateWorkOrderRequest;
  }): Promise<WorkOrderView> {
    const { projectId, workOrderId, actorId, request } = input;
    return this.uow.run(async (tx) => {
      const order = await tx.orders.findById(projectId, workOrderId, { lock: true });
      if (!order) throw new AppError('NOT_FOUND', 'Work order not found');
      order.assertVersion(request.expectedVersion);

      const patch: HeaderPatch = {
        ...(request.number !== undefined ? { number: request.number } : {}),
        ...(request.title !== undefined ? { title: request.title } : {}),
        ...(request.issuedOn !== undefined ? { issuedOn: request.issuedOn } : {}),
        ...(request.notes !== undefined ? { notes: request.notes } : {}),
      };
      const updated = await tx.orders.updateHeader(projectId, workOrderId, patch);
      const { header } = order;
      const changes = diffFields(
        {
          number: header.number,
          title: header.title,
          issuedOn: header.issuedOn,
          notes: header.notes,
        },
        { ...patch },
      );
      await tx.events.append({
        projectId,
        entity: EVENT_ENTITIES.workOrder,
        entityId: workOrderId,
        type: EVENT_TYPES.workOrderUpdated,
        actorId,
        payload: { ...changes, version: updated.version },
      });
      return {
        order: new WorkOrder(updated, order.items),
        attachments: await tx.attachments.listByWorkOrder(projectId, workOrderId),
      };
    });
  }
}
