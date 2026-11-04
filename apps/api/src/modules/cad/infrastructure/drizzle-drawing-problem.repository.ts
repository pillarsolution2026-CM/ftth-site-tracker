import type { DrawingProblemCode } from '@ftth/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { DbHandle } from '../../../db/db.module.js';
import { designRevisions, drawingProblemIgnores } from '../../../db/schema.js';
import type {
  DrawingProblemRepository,
  ProblemIgnoreRecord,
} from '../domain/design-revision.repository.js';

/** Every query carries `project_id` (IDOR defence). */
export class DrizzleDrawingProblemRepository implements DrawingProblemRepository {
  constructor(private readonly db: DbHandle) {}

  async warnings(projectId: string, revisionId: string): Promise<unknown> {
    const [row] = await this.db
      .select({ warnings: designRevisions.warnings })
      .from(designRevisions)
      .where(and(eq(designRevisions.projectId, projectId), eq(designRevisions.id, revisionId)));
    return row?.warnings ?? [];
  }

  async ignores(projectId: string, revisionId: string): Promise<ProblemIgnoreRecord[]> {
    const rows = await this.db
      .select({
        code: drawingProblemIgnores.code,
        handle: drawingProblemIgnores.handle,
        ignoredById: drawingProblemIgnores.ignoredBy,
        ignoredAt: drawingProblemIgnores.ignoredAt,
      })
      .from(drawingProblemIgnores)
      .where(
        and(
          eq(drawingProblemIgnores.projectId, projectId),
          eq(drawingProblemIgnores.revisionId, revisionId),
        ),
      )
      .orderBy(asc(drawingProblemIgnores.ignoredAt));
    return rows;
  }

  async ignore(
    projectId: string,
    revisionId: string,
    code: DrawingProblemCode,
    handle: string,
    actorId: string,
    at: Date,
  ): Promise<boolean> {
    const inserted = await this.db
      .insert(drawingProblemIgnores)
      .values({ projectId, revisionId, code, handle, ignoredBy: actorId, ignoredAt: at })
      .onConflictDoNothing({
        target: [
          drawingProblemIgnores.revisionId,
          drawingProblemIgnores.code,
          drawingProblemIgnores.handle,
        ],
      })
      .returning({ id: drawingProblemIgnores.id });
    return inserted.length === 1;
  }
}
