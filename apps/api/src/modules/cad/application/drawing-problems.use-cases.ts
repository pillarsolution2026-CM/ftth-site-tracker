import { drawingProblemsOf, problemTotalsOf, type DrawingProblemList } from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type {
  DesignRevisionRepository,
  DrawingProblemRepository,
} from '../domain/design-revision.repository.js';

/** Fail closed: entries that cannot be read count as blocking (ADR-041 review). */
export function problemList(warnings: unknown): DrawingProblemList {
  const { blocking, warnings: warningTotal, unreadable } = problemTotalsOf(warnings);
  return { items: drawingProblemsOf(warnings), total: blocking, warningTotal, unreadable };
}

export class ListDrawingProblemsUseCase {
  constructor(
    private readonly revisions: DesignRevisionRepository,
    private readonly problems: DrawingProblemRepository,
  ) {}

  async execute(projectId: string, revisionId: string): Promise<DrawingProblemList> {
    const revision = await this.revisions.find(projectId, revisionId);
    if (!revision) throw new AppError('NOT_FOUND', 'Design revision not found');
    const warnings = await this.problems.warnings(projectId, revisionId);
    return problemList(warnings);
  }
}
