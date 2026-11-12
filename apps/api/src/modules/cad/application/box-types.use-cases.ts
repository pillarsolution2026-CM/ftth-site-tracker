import {
  EVENT_ENTITIES,
  EVENT_TYPES,
  MAX_BOX_TYPE_CHOICES_PER_FILE,
  MAX_BOX_TYPE_CHOICE_ROWS_PER_FILE,
  boxTypeLabel,
  boxTypesApply,
  boxTypesChangedSince,
  evaluateBoxTypes,
  latestChoicePerShape,
  readingModeOf,
  type BoxTypesReport,
  type FrozenBoxTypes,
  type MappingRule,
  type SetBoxTypesRequest,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock, IdGenerator } from '../../../common/clock.js';
import type { BoxTypeChoiceRow } from '../domain/box-types.js';
import type { CadFile } from '../domain/cad-file.js';
import type { CadTx, CadUnitOfWork } from '../domain/cad-file.repository.js';
import { hasBuiltContent, type DesignRevision } from '../domain/design-revision.js';
import type { WorkOrderLines } from './ports.js';
import { requireRevision } from './design-revision-queries.use-cases.js';

const conflict = (reason: string, message: string, extra?: Record<string, unknown>) =>
  new AppError('CONFLICT', message, { reason, ...extra });

const unprocessable = (reason: string, message: string, extra: Record<string, unknown>) =>
  new AppError('VALIDATION_FAILED', message, { reason, ...extra }, 422);

/** The live state of a file's box types as the use cases return it. */
export interface BoxTypeStateModel {
  file: CadFile;
  applies: boolean;
  /** Every row, newest first. */
  history: BoxTypeChoiceRow[];
  /** The previous version's choices in force, or null when the file has no previous version. */
  previousVersion: {
    cadFileId: string;
    choices: { shape: string; workOrderLineId: string }[];
  } | null;
}

/** The choices in force: the latest row per shape, cleared shapes left out. */
export function activeChoicesOf(newestFirst: readonly BoxTypeChoiceRow[]): BoxTypeChoiceRow[] {
  return latestChoicePerShape(newestFirst).filter((row) => row.workOrderLineId !== null);
}

const modeApplies = async (tx: CadTx, file: CadFile): Promise<boolean> => {
  if (file.drawingKind !== 'secondary') return false;
  const mapping = await tx.mappings.find(file.projectId, file.id);
  return mapping !== null && boxTypesApply(file.drawingKind, readingModeOf(mapping.rules));
};

async function stateOf(tx: CadTx, file: CadFile): Promise<BoxTypeStateModel> {
  const applies = await modeApplies(tx, file);
  if (file.drawingKind !== 'secondary') {
    return { file, applies: false, history: [], previousVersion: null };
  }
  const history = await tx.boxTypes.listChoices(file.projectId, file.id);
  const previousId = await tx.boxTypes.previousVersionFileId(file.projectId, file.id);
  let previousVersion: BoxTypeStateModel['previousVersion'] = null;
  if (previousId) {
    const previousRows = await tx.boxTypes.listChoices(file.projectId, previousId);
    previousVersion = {
      cadFileId: previousId,
      choices: activeChoicesOf(previousRows).flatMap((row) =>
        row.workOrderLineId ? [{ shape: row.shape, workOrderLineId: row.workOrderLineId }] : [],
      ),
    };
  }
  return { file, applies, history, previousVersion };
}

export class GetBoxTypeStateUseCase {
  constructor(private readonly uow: CadUnitOfWork) {}

  execute(projectId: string, cadFileId: string): Promise<BoxTypeStateModel> {
    return this.uow.run(async (tx) => {
      const file = await tx.files.find(projectId, cadFileId);
      if (!file) throw new AppError('NOT_FOUND', 'CAD file not found');
      return stateOf(tx, file);
    });
  }
}

export class SetBoxTypesUseCase {
  constructor(
    private readonly uow: CadUnitOfWork,
    private readonly workOrderLines: WorkOrderLines,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(input: {
    projectId: string;
    cadFileId: string;
    actorId: string;
    request: SetBoxTypesRequest;
  }): Promise<BoxTypeStateModel> {
    const { projectId, cadFileId, actorId, request } = input;
    return this.uow.run(async (tx) => {
      // The file row lock serialises with revision creation (which freezes the choices), with the
      // other writes (the caps) and with a new version superseding the file.
      const file = await tx.files.find(projectId, cadFileId, { lock: true });
      if (!file) throw new AppError('NOT_FOUND', 'CAD file not found');
      if (file.drawingKind !== 'secondary') {
        throw conflict(
          'NOT_SECONDARY_DRAWING',
          'Box types are chosen on the Secondary drawing, not on the General',
        );
      }
      if (file.supersededAt !== null) {
        throw conflict('FILE_SUPERSEDED', 'A newer version of this drawing was uploaded', {
          supersededById: file.supersededById,
        });
      }
      const gallery = await tx.boxTypes.latestBuiltGallery(projectId, cadFileId);
      if (!gallery) {
        throw conflict('NOT_BUILT', 'The drawing has no built revision with a shape gallery yet');
      }
      const known = new Set(gallery.shapes.map((s) => s.shape));
      const unknown = request.choices.filter((c) => !known.has(c.shape)).map((c) => c.shape);
      if (unknown.length > 0) {
        throw unprocessable('SHAPE_NOT_FOUND', 'Some shapes are not in the drawing gallery', {
          shapes: unknown,
        });
      }

      const wanted = [
        ...new Set(request.choices.flatMap((c) => (c.workOrderLineId ? [c.workOrderLineId] : []))),
      ];
      if (wanted.length > 0) {
        const { exists, lines } = await this.workOrderLines.findLinesOfProject(projectId);
        if (!exists) {
          throw conflict(
            'NO_WORK_ORDER',
            'The project has no work order; create or import it first',
          );
        }
        const lineIds = new Set(lines.map((l) => l.id));
        const missing = wanted.filter((id) => !lineIds.has(id));
        if (missing.length > 0) {
          throw unprocessable(
            'LINE_NOT_IN_WORK_ORDER',
            'Some lines are not lines of the project work order',
            { workOrderLineIds: missing },
          );
        }
      }

      const before = await tx.boxTypes.listChoices(projectId, cadFileId);
      const inForce = new Map(latestChoicePerShape(before).map((row) => [row.shape, row]));
      const changes = request.choices.filter(
        (c) => (inForce.get(c.shape)?.workOrderLineId ?? null) !== c.workOrderLineId,
      );
      if (changes.length > 0) {
        const activeAfter = new Map(
          [...inForce.values()].map((row) => [row.shape, row.workOrderLineId]),
        );
        for (const c of changes) activeAfter.set(c.shape, c.workOrderLineId);
        const activeCount = [...activeAfter.values()].filter((id) => id !== null).length;
        if (
          activeCount > MAX_BOX_TYPE_CHOICES_PER_FILE ||
          before.length + changes.length > MAX_BOX_TYPE_CHOICE_ROWS_PER_FILE
        ) {
          throw conflict('TOO_MANY_CHOICES', 'The file has too many box type choices', {
            max: MAX_BOX_TYPE_CHOICES_PER_FILE,
          });
        }
        const now = this.clock.now();
        const rows = changes.map((c) => ({
          id: this.ids.next(),
          projectId,
          cadFileId,
          shape: c.shape,
          workOrderLineId: c.workOrderLineId,
          createdAt: now,
          createdById: actorId,
        }));
        await tx.boxTypes.insertChoices(rows);
        for (const row of rows) {
          await tx.events.append({
            projectId,
            entity: EVENT_ENTITIES.boxTypeChoice,
            entityId: row.id,
            type: EVENT_TYPES.boxTypeChosen,
            actorId,
            payload: {
              cadFileId,
              shape: row.shape,
              workOrderLineId: row.workOrderLineId,
              previousWorkOrderLineId: inForce.get(row.shape)?.workOrderLineId ?? null,
              fromPreviousVersion: request.fromPreviousVersion,
            },
          });
        }
      }
      return stateOf(tx, file);
    });
  }
}

/**
 * The Secondary's choices in force with a snapshot of their lines, frozen on a new revision (called
 * with the file row locked). null when box types do not apply (General, legacy reading mode).
 */
export async function freezeBoxTypes(
  tx: CadTx,
  workOrderLines: WorkOrderLines,
  file: CadFile,
  rules: readonly MappingRule[],
): Promise<FrozenBoxTypes | null> {
  if (!boxTypesApply(file.drawingKind, readingModeOf(rules))) return null;
  const active = activeChoicesOf(await tx.boxTypes.listChoices(file.projectId, file.id));
  if (active.length === 0) return { choices: [] };
  const { lines } = await workOrderLines.findLinesOfProject(file.projectId);
  const byId = new Map(lines.map((line) => [line.id, line]));
  const choices = active.flatMap((row) => {
    if (!row.workOrderLineId) return [];
    const line = byId.get(row.workOrderLineId);
    return [
      {
        choiceId: row.id,
        shape: row.shape,
        workOrderLineId: row.workOrderLineId,
        line: line
          ? {
              code: line.code,
              description: line.description,
              label: boxTypeLabel(line.description),
            }
          : null,
      },
    ];
  });
  choices.sort((a, b) => (a.shape < b.shape ? -1 : a.shape > b.shape ? 1 : 0));
  return { choices };
}

/**
 * The box-type check of one revision (ADR-043; readiness, publish and the report use it): the
 * gallery and the frozen choices against the work order's lines NOW.
 */
export async function boxTypesReportOf(
  tx: { boxTypes: CadTx['boxTypes'] },
  workOrderLines: WorkOrderLines,
  revision: DesignRevision,
): Promise<BoxTypesReport> {
  const applies = boxTypesApply(revision.drawingKind, readingModeOf(revision.rules));
  if (!applies) {
    return {
      ...evaluateBoxTypes({
        applies: false,
        gallery: null,
        frozen: null,
        workOrderExists: true,
        workOrderLineIds: new Set(),
      }),
      changedSinceBuild: false,
    };
  }
  const { exists, lines } = await workOrderLines.findLinesOfProject(revision.projectId);
  const evaluated = evaluateBoxTypes({
    applies: true,
    gallery: hasBuiltContent(revision) ? revision.boxShapes : null,
    frozen: revision.boxTypes,
    workOrderExists: exists,
    workOrderLineIds: new Set(lines.map((line) => line.id)),
  });
  // A published or discarded revision is history: what the PM chooses later is for the next build.
  let changedSinceBuild = false;
  if (revision.status === 'draft' || revision.status === 'failed') {
    const live = activeChoicesOf(
      await tx.boxTypes.listChoices(revision.projectId, revision.cadFileId),
    );
    changedSinceBuild = boxTypesChangedSince(
      revision.boxTypes,
      live.map((row) => row.id),
    );
  }
  return { ...evaluated, changedSinceBuild };
}

/** GET …/design-revisions/:r/box-types. */
export class GetRevisionBoxTypesUseCase {
  constructor(
    private readonly uow: CadUnitOfWork,
    private readonly workOrderLines: WorkOrderLines,
  ) {}

  execute(projectId: string, revisionId: string): Promise<BoxTypesReport> {
    return this.uow.run(async (tx) => {
      const revision = await requireRevision(tx.revisions, projectId, revisionId);
      return boxTypesReportOf(tx, this.workOrderLines, revision);
    });
  }
}
