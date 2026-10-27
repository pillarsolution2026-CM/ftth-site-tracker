import type { Database } from '../../../db/db.module.js';
import { DrizzleEventLog } from '../../../db/drizzle-event-log.js';
import type { WorkOrderTx, WorkOrderUnitOfWork } from '../domain/work-order.repository.js';
import { DrizzleWorkOrderAttachmentRepository } from './drizzle-work-order-attachment.repository.js';
import { DrizzleWorkOrderRepository } from './drizzle-work-order.repository.js';

/** One database transaction: repositories and the event log share it, so state and event commit together. */
export class DrizzleWorkOrderUnitOfWork implements WorkOrderUnitOfWork {
  constructor(private readonly db: Database) {}

  run<T>(work: (tx: WorkOrderTx) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) =>
      work({
        orders: new DrizzleWorkOrderRepository(tx),
        attachments: new DrizzleWorkOrderAttachmentRepository(tx),
        events: new DrizzleEventLog(tx),
      }),
    );
  }
}
