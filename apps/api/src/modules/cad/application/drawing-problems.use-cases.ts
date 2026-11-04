import {
  EVENT_ENTITIES,
  EVENT_TYPES,
  drawingProblemsOf,
  type DrawingProblem,
  type DrawingProblemList,
  type IgnoreDrawingProblemRequest,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock } from '../../../common/clock.js';
import type { CadUnitOfWork } from '../domain/cad-file.repository.js';
import { assertReviewable } from '../domain/design-revision.js';
import type {
  DesignRevisionRepository,
  DrawingProblemRepository,
  ProblemIgnoreRecord,
} from '../domain/design-revision.repository.js';

const placeKey = (code: string, handle: string) => `${code}\u0000${handle}`;

/** The worker's problems with who ignored which place and when (ADR-034). Pure. */
export function problemViews(
  problems: readonly DrawingProblem[],
  ignores: readonly ProblemIgnoreRecord[],
): DrawingProblemList {
  const ignored = new Map(ignores.map((i) => [placeKey(i.code, i.handle), i]));
  return {
    items: problems.map((problem) => {
      const items = problem.items.map((item) => {
        const record = ignored.get(placeKey(problem.code, item.handle));
        return {
          ...item,
          ignored: record ? { byId: record.ignoredById, at: record.ignoredAt.toISOString() } : null,
        };
      });
      return { ...problem, items, ignoredCount: items.filter((i) => i.ignored).length };
    }),
  };
}

export class ListDrawingProblemsUseCase {
  constructor(
    private readonly revisions: DesignRevisionRepository,
    private readonly problems: DrawingProblemRepository,
  ) {}

  async execute(projectId: string, revisionId: string): Promise<DrawingProblemList> {
    const revision = await this.revisions.find(projectId, revisionId);
    if (!revision) throw new AppError('NOT_FOUND', 'Design revision not found');
    const [warnings, ignores] = await Promise.all([
      this.problems.warnings(projectId, revisionId),
      this.problems.ignores(projectId, revisionId),
    ]);
    return problemViews(drawingProblemsOf(warnings), ignores);
  }
}

/**
 * Ignore one place of a drawing problem on the user's own responsibility. Draft revisions only;
 * the place must be one the worker listed; ignoring it twice keeps the first record.
 */
export class IgnoreDrawingProblemUseCase {
  constructor(
    private readonly uow: CadUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    projectId: string;
    revisionId: string;
    actorId: string;
    request: IgnoreDrawingProblemRequest;
  }): Promise<DrawingProblemList> {
    const { projectId, revisionId, actorId, request } = input;
    const now = this.clock.now();
    return this.uow.run(async (tx) => {
      // Publishing locks the same row, so an ignore and a publish never interleave.
      const revision = await tx.revisions.find(projectId, revisionId, { lock: true });
      if (!revision) throw new AppError('NOT_FOUND', 'Design revision not found');
      assertReviewable(revision);

      const problems = drawingProblemsOf(await tx.problems.warnings(projectId, revisionId));
      const item = problems
        .find((p) => p.code === request.code)
        ?.items.find((i) => i.handle === request.handle);
      if (!item) throw new AppError('NOT_FOUND', 'Drawing problem not found in this revision');

      const added = await tx.problems.ignore(
        projectId,
        revisionId,
        request.code,
        request.handle,
        actorId,
        now,
      );
      if (added) {
        await tx.events.append({
          projectId,
          entity: EVENT_ENTITIES.designRevision,
          entityId: revisionId,
          type: EVENT_TYPES.designRevisionProblemIgnored,
          actorId,
          payload: {
            code: request.code,
            handle: request.handle,
            layer: item.layer,
            acceptResponsibility: true,
          },
        });
      }
      return problemViews(problems, await tx.problems.ignores(projectId, revisionId));
    });
  }
}
