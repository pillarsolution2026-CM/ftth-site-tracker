import {
  EVENT_ENTITIES,
  EVENT_TYPES,
  MAX_CORRECTION_ROWS_PER_FILE,
  MAX_CORRECTIONS_PER_FILE,
  moveLayerTargets,
  type CreateDrawingCorrectionRequest,
  type DrawingCorrectionInput,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock, IdGenerator } from '../../../common/clock.js';
import type { CadUnitOfWork } from '../domain/cad-file.repository.js';
import type { DrawingCorrectionRecord, HandleKind } from '../domain/drawing-correction.js';

const handleNotFound = (handles: string[]) =>
  new AppError(
    'VALIDATION_FAILED',
    'The drawing has no such item for this correction',
    { reason: 'HANDLE_NOT_FOUND', handles },
    422,
  );

/** The handles a correction points at and the kinds of rows each may be (add_* point at none). */
function references(input: DrawingCorrectionInput): { handles: string[]; kinds: HandleKind[] } {
  switch (input.kind) {
    case 'move_layer':
      return { handles: [input.handle], kinds: ['insert', 'text', 'curve'] };
    case 'set_text':
      return { handles: [input.handle], kinds: ['text'] };
    case 'merge_routes':
      return { handles: input.handles, kinds: ['curve'] };
    default:
      return { handles: [], kinds: [] };
  }
}

export class ListDrawingCorrectionsUseCase {
  constructor(private readonly uow: CadUnitOfWork) {}

  execute(
    projectId: string,
    cadFileId: string,
  ): Promise<{ items: DrawingCorrectionRecord[]; activeCount: number }> {
    return this.uow.run(async (tx) => {
      if (!(await tx.files.find(projectId, cadFileId))) {
        throw new AppError('NOT_FOUND', 'CAD file not found');
      }
      const items = await tx.corrections.list(projectId, cadFileId);
      return { items, activeCount: items.filter((item) => item.withdrawnAt === null).length };
    });
  }
}

export class CreateDrawingCorrectionUseCase {
  constructor(
    private readonly uow: CadUnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(input: {
    projectId: string;
    cadFileId: string;
    actorId: string;
    request: CreateDrawingCorrectionRequest;
  }): Promise<DrawingCorrectionRecord> {
    const [created] = await this.executeMany({ ...input, requests: [input.request] });
    if (!created) throw new AppError('INTERNAL', 'The correction disappeared');
    return created;
  }

  /**
   * Adds several corrections in one transaction (ADR-047, the drawing's edit mode): all are kept or
   * none. They are recorded one millisecond apart, in the given order, so they apply in that order.
   */
  async executeMany(input: {
    projectId: string;
    cadFileId: string;
    actorId: string;
    requests: readonly CreateDrawingCorrectionRequest[];
  }): Promise<DrawingCorrectionRecord[]> {
    const { projectId, cadFileId, actorId, requests } = input;
    const ids = requests.map(() => this.ids.next());
    return this.uow.run(async (tx) => {
      // The file row lock serialises with revision creation (which freezes the corrections) and
      // with other additions (the cap).
      const file = await tx.files.find(projectId, cadFileId, { lock: true });
      if (!file) throw new AppError('NOT_FOUND', 'CAD file not found');
      if (file.status !== 'processed') {
        throw new AppError('CONFLICT', 'The CAD file is not processed yet', {
          reason: 'NOT_PROCESSED',
          status: file.status,
        });
      }
      // Active cap, and a cap on every row ever made so add + withdraw loops stay bounded (rows
      // are immutable and never deleted; security review M2).
      const [active, all] = await Promise.all([
        tx.corrections.countActive(projectId, cadFileId),
        tx.corrections.countAll(projectId, cadFileId),
      ]);
      if (
        active + requests.length > MAX_CORRECTIONS_PER_FILE ||
        all + requests.length > MAX_CORRECTION_ROWS_PER_FILE
      ) {
        throw new AppError('CONFLICT', 'The file has too many corrections', {
          reason: 'TOO_MANY_CORRECTIONS',
          max: MAX_CORRECTIONS_PER_FILE,
        });
      }

      const wanted = requests.map((request) => references(request.correction));
      const allHandles = [...new Set(wanted.flatMap((ref) => ref.handles))];
      if (allHandles.length > 0) {
        const found = await tx.corrections.handleKinds(projectId, cadFileId, allHandles);
        const missing = new Set<string>();
        for (const { handles, kinds } of wanted) {
          for (const handle of handles) {
            const have = found.get(handle);
            if (!have || !kinds.some((kind) => have.has(kind))) missing.add(handle);
          }
        }
        if (missing.size > 0) throw handleNotFound([...missing]);
      }

      // Owner 2026-11-09: a move only to a layer whose saved rule makes it a feature type or a
      // label; otherwise the item would drop out before the checks and its error would vanish.
      const moves = requests.flatMap((request) =>
        request.correction.kind === 'move_layer' ? [request.correction.toLayer] : [],
      );
      if (moves.length > 0) {
        const mapping = await tx.mappings.find(projectId, cadFileId);
        const targets = moveLayerTargets(mapping?.rules ?? []);
        const refused = moves.find((layer) => !targets.has(layer));
        if (refused !== undefined) {
          throw new AppError(
            'VALIDATION_FAILED',
            'The target layer has no rule that makes it a drawing item or label',
            { reason: 'LAYER_HAS_NO_RULE', layer: refused },
            422,
          );
        }
      }

      const now = this.clock.now().getTime();
      const out: DrawingCorrectionRecord[] = [];
      for (const [i, request] of requests.entries()) {
        const id = ids[i] as string;
        // A dismissal is about one problem place (ADR-046): that place is its context.
        const problem =
          request.correction.kind === 'dismiss_problem'
            ? { code: request.correction.code, handle: request.correction.handle }
            : request.problem;
        await tx.corrections.insert({
          id,
          projectId,
          cadFileId,
          correction: request.correction,
          problem,
          createdAt: new Date(now + i),
          createdById: actorId,
        });
        await tx.events.append({
          projectId,
          entity: EVENT_ENTITIES.drawingCorrection,
          entityId: id,
          type: EVENT_TYPES.drawingCorrectionAdded,
          actorId,
          payload: {
            cadFileId,
            kind: request.correction.kind,
            correction: request.correction,
            problem,
          },
        });
        const created = await tx.corrections.find(projectId, cadFileId, id);
        if (!created) throw new AppError('INTERNAL', 'The correction disappeared');
        out.push(created);
      }
      return out;
    });
  }
}

export class WithdrawDrawingCorrectionUseCase {
  constructor(
    private readonly uow: CadUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    projectId: string;
    cadFileId: string;
    correctionId: string;
    actorId: string;
  }): Promise<DrawingCorrectionRecord> {
    const { projectId, cadFileId, correctionId, actorId } = input;
    return this.uow.run(async (tx) => {
      // Same lock as creating a revision: a revision freezes either before or after, never between.
      if (!(await tx.files.find(projectId, cadFileId, { lock: true }))) {
        throw new AppError('NOT_FOUND', 'CAD file not found');
      }
      const current = await tx.corrections.find(projectId, cadFileId, correctionId, {
        lock: true,
      });
      if (!current) throw new AppError('NOT_FOUND', 'Correction not found');
      const done = await tx.corrections.withdraw(
        projectId,
        cadFileId,
        correctionId,
        actorId,
        this.clock.now(),
      );
      if (!done) {
        throw new AppError('CONFLICT', 'The correction was already withdrawn', {
          reason: 'ALREADY_WITHDRAWN',
        });
      }
      await tx.events.append({
        projectId,
        entity: EVENT_ENTITIES.drawingCorrection,
        entityId: correctionId,
        type: EVENT_TYPES.drawingCorrectionWithdrawn,
        actorId,
        payload: { cadFileId, kind: current.correction.kind },
      });
      const withdrawn = await tx.corrections.find(projectId, cadFileId, correctionId);
      if (!withdrawn) throw new AppError('INTERNAL', 'The correction disappeared');
      return withdrawn;
    });
  }
}
