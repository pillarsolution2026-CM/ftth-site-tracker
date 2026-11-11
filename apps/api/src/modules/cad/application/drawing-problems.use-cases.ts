import {
  drawingProblemsOf,
  problemTotals,
  type DrawingProblem,
  type DrawingProblemList,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type {
  DesignRevisionRepository,
  DrawingProblemRepository,
} from '../domain/design-revision.repository.js';

export function problemList(problems: DrawingProblem[]): DrawingProblemList {
  const { blocking, warnings } = problemTotals(problems);
  return { items: problems, total: blocking, warningTotal: warnings };
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
    return problemList(drawingProblemsOf(warnings));
  }
}
