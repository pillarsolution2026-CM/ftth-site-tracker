import type { SiteDrawingRecord, SiteDrawingState } from './site-drawing.js';

/** Every method filters by `projectId` (IDOR defence): another project's id is "not found". */
export interface SiteDrawingRepository {
  find(
    projectId: string,
    drawingId: string,
    options?: { lock?: boolean },
  ): Promise<SiteDrawingRecord | null>;
  /**
   * Every drawing of a site, withdrawn ones included, in General-first order. `lock` takes
   * SELECT … FOR UPDATE on the rows in id order, so two publishers or uploaders of one site queue.
   */
  listOfSite(
    projectId: string,
    siteId: string,
    options?: { lock?: boolean },
  ): Promise<SiteDrawingRecord[]>;
  /** Serialises the creation of a first drawing in a site (locks the project row). */
  lockProject(projectId: string): Promise<void>;
  /** Every non-withdrawn drawing of the project with its current file and newest revisions. */
  listWithState(projectId: string): Promise<SiteDrawingState[]>;
  insert(drawing: SiteDrawingRecord): Promise<void>;
  /** NULL → site, once (the database refuses a second link); the drawing takes `ordinal` in the site. */
  assignSite(projectId: string, drawingId: string, siteId: string, ordinal: number): Promise<void>;
  /** Sets withdrawn_at/by; the database refuses a drawing that was ever published. */
  withdraw(projectId: string, drawingId: string, actorId: string, at: Date): Promise<void>;
}
