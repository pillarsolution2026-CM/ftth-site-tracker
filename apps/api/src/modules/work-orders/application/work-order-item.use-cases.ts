import {
  EVENT_ENTITIES,
  EVENT_TYPES,
  type AddWorkOrderItemRequest,
  type UpdateWorkOrderItemRequest,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock, IdGenerator } from '../../../common/clock.js';
import { Decimal } from '../domain/decimal.js';
import type { WorkOrder, WorkOrderItem } from '../domain/work-order.js';
import type { WorkOrderTx, WorkOrderUnitOfWork } from '../domain/work-order.repository.js';
import { diffFields, itemSnapshot } from './snapshots.js';

interface ItemScope {
  projectId: string;
  workOrderId: string;
  actorId: string;
}

async function lockOrder(tx: WorkOrderTx, scope: ItemScope): Promise<WorkOrder> {
  // The row lock serialises concurrent edits, so line numbers and duplicate checks are race-free.
  const order = await tx.orders.findById(scope.projectId, scope.workOrderId, { lock: true });
  if (!order) throw new AppError('NOT_FOUND', 'Work order not found');
  return order;
}

export class AddWorkOrderItemUseCase {
  constructor(
    private readonly uow: WorkOrderUnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  execute(input: ItemScope & { request: AddWorkOrderItemRequest }): Promise<WorkOrderItem> {
    const { request } = input;
    return this.uow.run(async (tx) => {
      const order = await lockOrder(tx, input);
      const item = order.buildItem(
        {
          code: request.code,
          description: request.description,
          unit: request.unit,
          quantity: Decimal.parse(request.quantity),
          unitPrice: Decimal.parse(request.unitPrice),
          workType: request.workType,
        },
        { lineNo: request.lineNo, acceptDuplicateCode: request.acceptDuplicateCode },
        this.ids,
        this.clock.now(),
      );
      await tx.orders.insertItem(input.projectId, input.workOrderId, item);
      await tx.events.append({
        projectId: input.projectId,
        entity: EVENT_ENTITIES.workOrderItem,
        entityId: item.id,
        type: EVENT_TYPES.workOrderItemAdded,
        actorId: input.actorId,
        payload: { workOrderId: input.workOrderId, ...itemSnapshot(item) },
      });
      return item;
    });
  }
}

export class UpdateWorkOrderItemUseCase {
  constructor(
    private readonly uow: WorkOrderUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(
    input: ItemScope & { itemId: string; request: UpdateWorkOrderItemRequest },
  ): Promise<WorkOrderItem> {
    const { request } = input;
    return this.uow.run(async (tx) => {
      const order = await lockOrder(tx, input);
      const { before, after } = order.changeItem(
        input.itemId,
        {
          code: request.code,
          description: request.description,
          unit: request.unit,
          quantity: request.quantity === undefined ? undefined : Decimal.parse(request.quantity),
          unitPrice: request.unitPrice === undefined ? undefined : Decimal.parse(request.unitPrice),
          workType: request.workType,
        },
        request.acceptDuplicateCode,
        this.clock.now(),
      );
      await tx.orders.updateItem(input.projectId, input.workOrderId, after);
      await tx.events.append({
        projectId: input.projectId,
        entity: EVENT_ENTITIES.workOrderItem,
        entityId: after.id,
        type: EVENT_TYPES.workOrderItemUpdated,
        actorId: input.actorId,
        payload: {
          workOrderId: input.workOrderId,
          lineNo: after.lineNo,
          ...diffFields(itemSnapshot(before), itemSnapshot(after)),
        },
      });
      return after;
    });
  }
}

export class RemoveWorkOrderItemUseCase {
  constructor(private readonly uow: WorkOrderUnitOfWork) {}

  execute(input: ItemScope & { itemId: string }): Promise<void> {
    return this.uow.run(async (tx) => {
      const order = await lockOrder(tx, input);
      const item = order.findItem(input.itemId);
      await tx.orders.deleteItem(input.projectId, input.workOrderId, item.id);
      await tx.events.append({
        projectId: input.projectId,
        entity: EVENT_ENTITIES.workOrderItem,
        entityId: item.id,
        type: EVENT_TYPES.workOrderItemRemoved,
        actorId: input.actorId,
        // Line numbers are not compacted; the snapshot records what was removed.
        payload: { workOrderId: input.workOrderId, ...itemSnapshot(item) },
      });
    });
  }
}
