import {
  EVENT_ENTITIES,
  EVENT_TYPES,
  type AddWorkOrderItemRequest,
  type UpdateWorkOrderItemRequest,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock, IdGenerator } from '../../../common/clock.js';
import {
  assertLinesFit,
  assertWithinContract,
  findContractItem,
  lineFromContract,
  reservedOf,
} from '../domain/contract-lines.js';
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
      // Contract row lock after the order lock: the reservation sum below cannot change under us.
      const contract = await tx.contracts.loadApproved(input.projectId, { lock: true });
      const line = lineFromContract(
        contract,
        request.contractItemId,
        Decimal.parse(request.quantity),
      );
      const item = order.buildItem(line, { lineNo: request.lineNo }, this.ids, this.clock.now());
      assertLinesFit(contract, await tx.contracts.reservations(contract.id), [line]);
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
      const { before, after } = order.changeQuantity(
        input.itemId,
        Decimal.parse(request.quantity),
        this.clock.now(),
      );
      const contract = await tx.contracts.loadApproved(input.projectId, { lock: true });
      const contractItem = findContractItem(contract, after.contractItemId ?? '');
      const reservations = await tx.contracts.reservations(contract.id);
      // The line itself is not "other" reservation: take its current quantity out.
      const others = reservedOf(reservations, contractItem.id).sub(before.quantity);
      assertWithinContract(contractItem, others, after.quantity);
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
