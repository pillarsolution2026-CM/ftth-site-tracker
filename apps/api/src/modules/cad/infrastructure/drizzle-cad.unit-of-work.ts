import type { Database } from '../../../db/db.module.js';
import { DrizzleEventLog } from '../../../db/drizzle-event-log.js';
import type { CadTx, CadUnitOfWork } from '../domain/cad-file.repository.js';
import { DrizzleCadFileRepository } from './drizzle-cad-file.repository.js';
import { DrizzleCadMappingRepository } from './drizzle-cad-mapping.repository.js';
import { DrizzleDesignRevisionRepository } from './drizzle-design-revision.repository.js';
import { DrizzleTextLinkRepository } from './drizzle-text-link.repository.js';

/** Repositories and the event log share one transaction, so a state change and its event commit together. */
export class DrizzleCadUnitOfWork implements CadUnitOfWork {
  constructor(private readonly db: Database) {}

  run<T>(work: (tx: CadTx) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) =>
      work({
        files: new DrizzleCadFileRepository(tx),
        mappings: new DrizzleCadMappingRepository(tx),
        revisions: new DrizzleDesignRevisionRepository(tx),
        links: new DrizzleTextLinkRepository(tx),
        events: new DrizzleEventLog(tx),
      }),
    );
  }
}
