import type { Database } from '../../../db/db.module.js';
import { DrizzleEventLog } from '../../../db/drizzle-event-log.js';
import type { ContractorTx, ContractorUnitOfWork } from '../domain/contractor.repository.js';
import { DrizzleContractorRepository } from './drizzle-contractor.repository.js';
import { DrizzleRegistrationRepository } from './drizzle-registration.repository.js';

/** One database transaction: repositories and the event log share it, so state and event commit together. */
export class DrizzleContractorUnitOfWork implements ContractorUnitOfWork {
  constructor(private readonly db: Database) {}

  run<T>(work: (tx: ContractorTx) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) =>
      work({
        contractors: new DrizzleContractorRepository(tx),
        registrations: new DrizzleRegistrationRepository(tx),
        events: new DrizzleEventLog(tx),
      }),
    );
  }
}
