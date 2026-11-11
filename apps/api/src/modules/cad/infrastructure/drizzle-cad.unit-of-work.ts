import type { Database } from '../../../db/db.module.js';
import { DrizzleEventLog } from '../../../db/drizzle-event-log.js';
import type { CadTx, CadUnitOfWork } from '../domain/cad-file.repository.js';
import { DrizzleCadFileRepository } from './drizzle-cad-file.repository.js';
import { DrizzleCadMappingRepository } from './drizzle-cad-mapping.repository.js';
import { DrizzleDrawingCorrectionRepository } from './drizzle-drawing-correction.repository.js';
import { DrizzleDesignRevisionRepository } from './drizzle-design-revision.repository.js';
import { DrizzleDrawingProblemRepository } from './drizzle-drawing-problem.repository.js';
import { DrizzleGpsProposalRepository } from './drizzle-gps-proposal.repository.js';
import { DrizzleInstallationRepository } from './drizzle-installation.repository.js';
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
        problems: new DrizzleDrawingProblemRepository(tx),
        proposals: new DrizzleGpsProposalRepository(tx),
        corrections: new DrizzleDrawingCorrectionRepository(tx),
        installation: new DrizzleInstallationRepository(tx),
        events: new DrizzleEventLog(tx),
      }),
    );
  }
}
