import {
  EVENT_ENTITIES,
  EVENT_TYPES,
  MAX_INSTALLATION_ANSWERS_PER_FILE,
  MAX_TRENCH_MARKS_PER_FILE,
  MAX_TRENCH_MARK_ROWS_PER_FILE,
  evaluateInstallation,
  installationQuestionApplies,
  type CreateTrenchMarkRequest,
  type InstallationReport,
  type SetInstallationAnswerRequest,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock, IdGenerator } from '../../../common/clock.js';
import type { CadFile } from '../domain/cad-file.js';
import type { CadTx, CadUnitOfWork } from '../domain/cad-file.repository.js';
import { hasBuiltContent, type DesignRevision } from '../domain/design-revision.js';
import type { InstallationAnswerRow, TrenchMarkRecord } from '../domain/installation.js';
import { requireRevision } from './design-revision-queries.use-cases.js';

const conflict = (reason: string, message: string, extra?: Record<string, unknown>) =>
  new AppError('CONFLICT', message, { reason, ...extra });

/** The live state of a file's installation as the use cases return it. */
export interface InstallationStateModel {
  file: CadFile;
  answers: InstallationAnswerRow[];
  marks: TrenchMarkRecord[];
}

export class GetInstallationUseCase {
  constructor(private readonly uow: CadUnitOfWork) {}

  execute(projectId: string, cadFileId: string): Promise<InstallationStateModel> {
    return this.uow.run(async (tx) => {
      const file = await tx.files.find(projectId, cadFileId);
      if (!file) throw new AppError('NOT_FOUND', 'CAD file not found');
      // A Secondary is never asked: nothing to read (and the tables refuse its rows).
      if (!installationQuestionApplies(file.drawingKind)) return { file, answers: [], marks: [] };
      const [answers, marks] = await Promise.all([
        tx.installation.listAnswers(projectId, cadFileId),
        tx.installation.listMarks(projectId, cadFileId),
      ]);
      return { file, answers, marks };
    });
  }
}

/** Locks the file row and checks it is a current General (the writes' common rules). */
async function lockCurrentGeneral(
  tx: CadTx,
  projectId: string,
  cadFileId: string,
): Promise<CadFile> {
  // The file row lock serialises with revision creation (which freezes the installation) and with
  // other writes (the caps).
  const file = await tx.files.find(projectId, cadFileId, { lock: true });
  if (!file) throw new AppError('NOT_FOUND', 'CAD file not found');
  if (!installationQuestionApplies(file.drawingKind)) {
    throw conflict(
      'NOT_GENERAL_DRAWING',
      'Only a General drawing has an installation question (a Secondary is all trench)',
    );
  }
  if (file.supersededAt !== null) {
    throw conflict('FILE_SUPERSEDED', 'A newer version of this drawing was uploaded', {
      supersededById: file.supersededById,
    });
  }
  return file;
}

export class SetInstallationAnswerUseCase {
  constructor(
    private readonly uow: CadUnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(input: {
    projectId: string;
    cadFileId: string;
    actorId: string;
    request: SetInstallationAnswerRequest;
  }): Promise<InstallationAnswerRow> {
    const { projectId, cadFileId, actorId, request } = input;
    const id = this.ids.next();
    return this.uow.run(async (tx) => {
      await lockCurrentGeneral(tx, projectId, cadFileId);
      const [latest] = await tx.installation.listAnswers(projectId, cadFileId);
      // The same answer again changes nothing: no new row, no event.
      if (latest?.answer === request.answer) return latest;

      if (request.answer === 'pull_only') {
        const active = await tx.installation.countActiveMarks(projectId, cadFileId);
        if (active > 0) {
          throw conflict(
            'TRENCH_MARKS_ACTIVE',
            'Withdraw the trench marks before answering that nothing is trenched',
            { activeMarks: active },
          );
        }
      }
      if (
        (await tx.installation.countAnswers(projectId, cadFileId)) >=
        MAX_INSTALLATION_ANSWERS_PER_FILE
      ) {
        throw conflict('TOO_MANY_ANSWERS', 'The file has too many installation answers', {
          max: MAX_INSTALLATION_ANSWERS_PER_FILE,
        });
      }

      await tx.installation.insertAnswer({
        id,
        projectId,
        cadFileId,
        answer: request.answer,
        createdAt: this.clock.now(),
        createdById: actorId,
      });
      await tx.events.append({
        projectId,
        entity: EVENT_ENTITIES.installationAnswer,
        entityId: id,
        type: EVENT_TYPES.installationAnswered,
        actorId,
        payload: {
          cadFileId,
          answer: request.answer,
          previousAnswer: latest?.answer ?? null,
        },
      });
      const [created] = await tx.installation.listAnswers(projectId, cadFileId);
      if (created?.id !== id) throw new AppError('INTERNAL', 'The answer disappeared');
      return created;
    });
  }
}

export class AddTrenchMarkUseCase {
  constructor(
    private readonly uow: CadUnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(input: {
    projectId: string;
    cadFileId: string;
    actorId: string;
    request: CreateTrenchMarkRequest;
  }): Promise<TrenchMarkRecord> {
    const { projectId, cadFileId, actorId, request } = input;
    const id = this.ids.next();
    return this.uow.run(async (tx) => {
      const file = await lockCurrentGeneral(tx, projectId, cadFileId);
      if (file.status !== 'processed') {
        throw conflict('NOT_PROCESSED', 'The CAD file is not processed yet', {
          status: file.status,
        });
      }
      const [latest] = await tx.installation.listAnswers(projectId, cadFileId);
      if (latest?.answer !== 'has_trench') {
        throw conflict(
          'ANSWER_NOT_TRENCH',
          'Trench marks need the answer that some parts need trenching',
          { answer: latest?.answer ?? null },
        );
      }
      const [active, all] = await Promise.all([
        tx.installation.countActiveMarks(projectId, cadFileId),
        tx.installation.countAllMarks(projectId, cadFileId),
      ]);
      // Active cap, and a cap on every row ever made so add + withdraw loops stay bounded.
      if (active >= MAX_TRENCH_MARKS_PER_FILE || all >= MAX_TRENCH_MARK_ROWS_PER_FILE) {
        throw conflict('TOO_MANY_MARKS', 'The file has too many trench marks', {
          max: MAX_TRENCH_MARKS_PER_FILE,
        });
      }
      if (!(await tx.installation.curveExists(projectId, cadFileId, request.routeHandle))) {
        throw new AppError(
          'VALIDATION_FAILED',
          'The drawing has no such route line',
          { reason: 'ROUTE_NOT_FOUND', handle: request.routeHandle },
          422,
        );
      }

      await tx.installation.insertMark({
        id,
        projectId,
        cadFileId,
        routeHandle: request.routeHandle,
        lengthM: request.lengthM,
        createdAt: this.clock.now(),
        createdById: actorId,
      });
      await tx.events.append({
        projectId,
        entity: EVENT_ENTITIES.trenchMark,
        entityId: id,
        type: EVENT_TYPES.trenchMarkAdded,
        actorId,
        payload: { cadFileId, routeHandle: request.routeHandle, lengthM: request.lengthM },
      });
      const created = await tx.installation.findMark(projectId, cadFileId, id);
      if (!created) throw new AppError('INTERNAL', 'The trench mark disappeared');
      return created;
    });
  }
}

export class WithdrawTrenchMarkUseCase {
  constructor(
    private readonly uow: CadUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    projectId: string;
    cadFileId: string;
    markId: string;
    actorId: string;
  }): Promise<TrenchMarkRecord> {
    const { projectId, cadFileId, markId, actorId } = input;
    return this.uow.run(async (tx) => {
      // Same lock as creating a revision: a revision freezes either before or after, never between.
      if (!(await tx.files.find(projectId, cadFileId, { lock: true }))) {
        throw new AppError('NOT_FOUND', 'CAD file not found');
      }
      const current = await tx.installation.findMark(projectId, cadFileId, markId, { lock: true });
      if (!current) throw new AppError('NOT_FOUND', 'Trench mark not found');
      const done = await tx.installation.withdrawMark(
        projectId,
        cadFileId,
        markId,
        actorId,
        this.clock.now(),
      );
      if (!done) throw conflict('ALREADY_WITHDRAWN', 'The trench mark was already withdrawn');
      await tx.events.append({
        projectId,
        entity: EVENT_ENTITIES.trenchMark,
        entityId: markId,
        type: EVENT_TYPES.trenchMarkWithdrawn,
        actorId,
        payload: { cadFileId, routeHandle: current.routeHandle, lengthM: current.lengthM },
      });
      const withdrawn = await tx.installation.findMark(projectId, cadFileId, markId);
      if (!withdrawn) throw new AppError('INTERNAL', 'The trench mark disappeared');
      return withdrawn;
    });
  }
}

/**
 * The installation check of one revision (ADR-042; readiness, publish and the report all use it):
 * the frozen answer and marks against the revision's route features, through its frozen merges.
 * A Secondary is always ok. Only a built revision has features to compare with.
 */
export async function installationReportOf(
  tx: { revisions: CadTx['revisions'] },
  revision: DesignRevision,
): Promise<InstallationReport> {
  if (!installationQuestionApplies(revision.drawingKind)) {
    return evaluateInstallation({
      drawingKind: revision.drawingKind,
      frozen: null,
      routes: [],
      merges: [],
    });
  }
  const built = hasBuiltContent(revision);
  const [routes, merges] = built
    ? await Promise.all([
        tx.revisions.installationRoutes(revision.projectId, revision.id),
        tx.revisions.frozenMergeHandles(revision.projectId, revision.id),
      ])
    : [[], []];
  return evaluateInstallation({
    drawingKind: revision.drawingKind,
    frozen: revision.installation,
    routes,
    merges,
  });
}

/** GET …/design-revisions/:r/installation. */
export class GetRevisionInstallationUseCase {
  constructor(private readonly uow: CadUnitOfWork) {}

  execute(projectId: string, revisionId: string): Promise<InstallationReport> {
    return this.uow.run(async (tx) => {
      const revision = await requireRevision(tx.revisions, projectId, revisionId);
      return installationReportOf(tx, revision);
    });
  }
}
