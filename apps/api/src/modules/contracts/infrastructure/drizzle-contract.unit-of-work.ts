import type { Database } from '../../../db/db.module.js';
import { DrizzleEventLog } from '../../../db/drizzle-event-log.js';
import type { ContractTx, ContractUnitOfWork } from '../domain/contract.repository.js';
import { DrizzleContractAttachmentRepository } from './drizzle-contract-attachment.repository.js';
import { DrizzleContractRepository } from './drizzle-contract.repository.js';

/** One database transaction: repositories and the event log share it, so state and event commit together. */
export class DrizzleContractUnitOfWork implements ContractUnitOfWork {
  constructor(private readonly db: Database) {}

  run<T>(work: (tx: ContractTx) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) =>
      work({
        contracts: new DrizzleContractRepository(tx),
        attachments: new DrizzleContractAttachmentRepository(tx),
        events: new DrizzleEventLog(tx),
      }),
    );
  }
}
