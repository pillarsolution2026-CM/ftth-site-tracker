import type {
  DrawingCorrectionInput,
  DrawingProblemCode,
  FrozenDrawingCorrection,
} from '@ftth/shared';

/** A drawing correction stored with its CAD file (ADR-038). Dates are real dates here. */
export interface DrawingCorrectionRecord {
  id: string;
  projectId: string;
  cadFileId: string;
  correction: DrawingCorrectionInput;
  problem: { code: DrawingProblemCode; handle: string } | null;
  createdBy: { id: string; name: string } | null;
  createdAt: Date;
  withdrawnBy: { id: string; name: string } | null;
  withdrawnAt: Date | null;
}

export type NewDrawingCorrection = Pick<
  DrawingCorrectionRecord,
  'id' | 'projectId' | 'cadFileId' | 'correction' | 'problem' | 'createdAt'
> & { createdById: string };

/** Which extracted tables hold a handle. */
export type HandleKind = 'insert' | 'text' | 'curve';

/** Every method filters by `projectId` (IDOR defence): another project's id is "not found". */
export interface DrawingCorrectionRepository {
  /** Newest first (created_at DESC, id DESC), withdrawn ones included. */
  list(projectId: string, cadFileId: string): Promise<DrawingCorrectionRecord[]>;
  find(
    projectId: string,
    cadFileId: string,
    correctionId: string,
    options?: { lock?: boolean },
  ): Promise<DrawingCorrectionRecord | null>;
  countActive(projectId: string, cadFileId: string): Promise<number>;
  /** The corrections in force, in creation order (created_at, id): what a revision freezes. */
  listActiveFrozen(projectId: string, cadFileId: string): Promise<FrozenDrawingCorrection[]>;
  /** For each given handle, the kinds of extracted rows of this file that carry it. */
  handleKinds(
    projectId: string,
    cadFileId: string,
    handles: string[],
  ): Promise<Map<string, Set<HandleKind>>>;
  insert(correction: NewDrawingCorrection): Promise<void>;
  /** active -> withdrawn; false when it was already withdrawn. */
  withdraw(
    projectId: string,
    cadFileId: string,
    correctionId: string,
    actorId: string,
    at: Date,
  ): Promise<boolean>;
}
