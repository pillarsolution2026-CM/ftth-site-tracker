import type { RawWorkbook } from '../domain/import/raw-workbook.js';

/** Currency of a project, read through the projects module's application service. */
export interface ProjectCurrencyLookup {
  /** Throws AppError NOT_FOUND if the project does not exist. */
  currencyOf(projectId: string): Promise<string>;
}

/** Turns xlsx bytes into the neutral workbook model. Throws AppError UNSUPPORTED_FILE if unreadable. */
export interface WorkbookReader {
  read(file: Buffer): Promise<RawWorkbook>;
}
