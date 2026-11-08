import { and, eq } from 'drizzle-orm';
import type { DbHandle } from '../../../db/db.module.js';
import { designRevisions } from '../../../db/schema.js';
import type { DrawingProblemRepository } from '../domain/design-revision.repository.js';

/** Every query carries `project_id` (IDOR defence). Recorded ignores are no longer read (ADR-038). */
export class DrizzleDrawingProblemRepository implements DrawingProblemRepository {
  constructor(private readonly db: DbHandle) {}

  async warnings(projectId: string, revisionId: string): Promise<unknown> {
    const [row] = await this.db
      .select({ warnings: designRevisions.warnings })
      .from(designRevisions)
      .where(and(eq(designRevisions.projectId, projectId), eq(designRevisions.id, revisionId)));
    return row?.warnings ?? [];
  }
}
