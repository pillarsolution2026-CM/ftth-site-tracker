import { BoxShapeGallerySchema, type BoxShapeGallery } from '@ftth/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { DbHandle } from '../../../db/db.module.js';
import { cadFileBoxTypeChoices, cadFiles, designRevisions, users } from '../../../db/schema.js';
import type { BoxTypeChoiceRow, BoxTypeRepository, NewBoxTypeChoice } from '../domain/box-types.js';

/** Every query carries `project_id` (IDOR defence). */
export class DrizzleBoxTypeRepository implements BoxTypeRepository {
  constructor(private readonly db: DbHandle) {}

  async listChoices(projectId: string, cadFileId: string): Promise<BoxTypeChoiceRow[]> {
    const rows = await this.db
      .select()
      .from(cadFileBoxTypeChoices)
      .where(
        and(
          eq(cadFileBoxTypeChoices.projectId, projectId),
          eq(cadFileBoxTypeChoices.cadFileId, cadFileId),
        ),
      )
      .orderBy(desc(cadFileBoxTypeChoices.seq));
    const wanted = [
      ...new Set(rows.map((row) => row.createdBy).filter((id): id is string => id !== null)),
    ];
    const found =
      wanted.length === 0
        ? []
        : await this.db
            .select({ id: users.id, name: users.displayName })
            .from(users)
            .where(inArray(users.id, wanted));
    const names = new Map(found.map((user) => [user.id, user.name]));
    return rows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      cadFileId: row.cadFileId,
      shape: row.shapeSignature,
      workOrderLineId: row.workOrderItemId,
      createdBy: row.createdBy ? { id: row.createdBy, name: names.get(row.createdBy) ?? '' } : null,
      createdAt: row.createdAt,
    }));
  }

  async insertChoices(choices: NewBoxTypeChoice[]): Promise<void> {
    if (choices.length === 0) return;
    await this.db.insert(cadFileBoxTypeChoices).values(
      choices.map((choice) => ({
        id: choice.id,
        projectId: choice.projectId,
        cadFileId: choice.cadFileId,
        shapeSignature: choice.shape,
        workOrderItemId: choice.workOrderLineId,
        createdBy: choice.createdById,
        createdAt: choice.createdAt,
      })),
    );
  }

  async latestBuiltGallery(projectId: string, cadFileId: string): Promise<BoxShapeGallery | null> {
    const [row] = await this.db
      .select({ boxShapes: designRevisions.boxShapes })
      .from(designRevisions)
      .where(
        and(
          eq(designRevisions.projectId, projectId),
          eq(designRevisions.cadFileId, cadFileId),
          inArray(designRevisions.status, ['draft', 'published']),
        ),
      )
      .orderBy(desc(designRevisions.createdAt), desc(designRevisions.id))
      .limit(1);
    if (!row) return null;
    return BoxShapeGallerySchema.safeParse(row.boxShapes).data ?? null;
  }

  async previousVersionFileId(projectId: string, cadFileId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ id: cadFiles.id })
      .from(cadFiles)
      .where(and(eq(cadFiles.projectId, projectId), eq(cadFiles.supersededBy, cadFileId)))
      .limit(1);
    return row?.id ?? null;
  }
}
