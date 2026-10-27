import { EVENT_ENTITIES, EVENT_TYPES } from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { ObjectStorage } from '../../../common/object-storage.port.js';
import { discardObject } from '../../../common/storage/discard-object.js';
import type { WorkOrderUnitOfWork } from '../domain/work-order.repository.js';
import { orderSnapshot } from './snapshots.js';

export class DeleteWorkOrderUseCase {
  constructor(
    private readonly uow: WorkOrderUnitOfWork,
    private readonly storage: ObjectStorage,
  ) {}

  async execute(input: { projectId: string; workOrderId: string; actorId: string }): Promise<void> {
    const { projectId, workOrderId, actorId } = input;
    const storageKeys = await this.uow.run(async (tx) => {
      const order = await tx.orders.findById(projectId, workOrderId, { lock: true });
      if (!order) throw new AppError('NOT_FOUND', 'Work order not found');
      const attachments = await tx.attachments.listByWorkOrder(projectId, workOrderId);

      await tx.events.append({
        projectId,
        entity: EVENT_ENTITIES.workOrder,
        entityId: workOrderId,
        type: EVENT_TYPES.workOrderDeleted,
        actorId,
        // The rows are hard-deleted, so the event is the only remaining record of them.
        payload: {
          ...orderSnapshot(order),
          attachments: attachments.map((a) => ({
            id: a.id,
            kind: a.kind,
            fileName: a.fileName,
            sha256: a.sha256,
            sizeBytes: a.sizeBytes,
          })),
        },
      });
      await tx.orders.delete(projectId, workOrderId);
      return attachments.map((attachment) => attachment.storageKey);
    });

    // After commit: a failed delete only leaves an orphan object, never a dangling row.
    for (const key of storageKeys) {
      await discardObject(this.storage, key);
    }
  }
}
