import type { FrozenInstallation, InstallationAnswer } from '@ftth/shared';

/** One answer row of a General CAD file (ADR-042). Dates are real dates here. */
export interface InstallationAnswerRow {
  id: string;
  projectId: string;
  cadFileId: string;
  answer: InstallationAnswer;
  createdBy: { id: string; name: string } | null;
  createdAt: Date;
}

export type NewInstallationAnswer = Pick<
  InstallationAnswerRow,
  'id' | 'projectId' | 'cadFileId' | 'answer' | 'createdAt'
> & { createdById: string };

/** One trench mark of a General CAD file (ADR-042). `lengthM` is metres, 3 decimals. */
export interface TrenchMarkRecord {
  id: string;
  projectId: string;
  cadFileId: string;
  routeHandle: string;
  lengthM: string;
  createdBy: { id: string; name: string } | null;
  createdAt: Date;
  withdrawnBy: { id: string; name: string } | null;
  withdrawnAt: Date | null;
}

export type NewTrenchMark = Pick<
  TrenchMarkRecord,
  'id' | 'projectId' | 'cadFileId' | 'routeHandle' | 'lengthM' | 'createdAt'
> & { createdById: string };

/** Every method filters by `projectId` (IDOR defence): another project's id is "not found". */
export interface InstallationRepository {
  /** Newest first (created_at DESC, id DESC). */
  listAnswers(projectId: string, cadFileId: string): Promise<InstallationAnswerRow[]>;
  countAnswers(projectId: string, cadFileId: string): Promise<number>;
  insertAnswer(answer: NewInstallationAnswer): Promise<void>;
  /** Newest first, withdrawn ones included. */
  listMarks(projectId: string, cadFileId: string): Promise<TrenchMarkRecord[]>;
  findMark(
    projectId: string,
    cadFileId: string,
    markId: string,
    options?: { lock?: boolean },
  ): Promise<TrenchMarkRecord | null>;
  countActiveMarks(projectId: string, cadFileId: string): Promise<number>;
  /** Every row of the file, withdrawn ones included. */
  countAllMarks(projectId: string, cadFileId: string): Promise<number>;
  insertMark(mark: NewTrenchMark): Promise<void>;
  /** active -> withdrawn; false when it was already withdrawn. */
  withdrawMark(
    projectId: string,
    cadFileId: string,
    markId: string,
    actorId: string,
    at: Date,
  ): Promise<boolean>;
  /** True when the handle is a curve of the file's extraction. */
  curveExists(projectId: string, cadFileId: string, handle: string): Promise<boolean>;
  /** The answer in force and the marks in force (creation order): what a revision freezes. */
  frozen(projectId: string, cadFileId: string): Promise<FrozenInstallation>;
}
