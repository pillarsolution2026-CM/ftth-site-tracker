import type { FrozenDrawingCorrection } from '@ftth/shared';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DbHandle } from '../../../db/db.module.js';
import { cadCurves, cadFileCorrections, cadInserts, cadTexts, users } from '../../../db/schema.js';
import type {
  DrawingCorrectionRecord,
  DrawingCorrectionRepository,
  HandleKind,
  NewDrawingCorrection,
} from '../domain/drawing-correction.js';

type Row = typeof cadFileCorrections.$inferSelect;
type Names = Map<string, string>;

const inFile = (projectId: string, cadFileId: string) =>
  and(eq(cadFileCorrections.projectId, projectId), eq(cadFileCorrections.cadFileId, cadFileId));

/** Every query carries `project_id` (IDOR defence). */
export class DrizzleDrawingCorrectionRepository implements DrawingCorrectionRepository {
  constructor(private readonly db: DbHandle) {}

  private async names(rows: Row[]): Promise<Names> {
    const ids = new Set<string>();
    for (const row of rows) {
      if (row.createdBy) ids.add(row.createdBy);
      if (row.withdrawnBy) ids.add(row.withdrawnBy);
    }
    if (ids.size === 0) return new Map();
    const found = await this.db
      .select({ id: users.id, name: users.displayName })
      .from(users)
      .where(inArray(users.id, [...ids]));
    return new Map(found.map((user) => [user.id, user.name]));
  }

  private toRecord(row: Row, names: Names): DrawingCorrectionRecord {
    const person = (id: string | null) => (id ? { id, name: names.get(id) ?? '' } : null);
    return {
      id: row.id,
      projectId: row.projectId,
      cadFileId: row.cadFileId,
      correction: row.correction,
      problem:
        row.problemCode && row.problemHandle
          ? { code: row.problemCode, handle: row.problemHandle }
          : null,
      createdBy: person(row.createdBy),
      createdAt: row.createdAt,
      withdrawnBy: person(row.withdrawnBy),
      withdrawnAt: row.withdrawnAt,
    };
  }

  async list(projectId: string, cadFileId: string): Promise<DrawingCorrectionRecord[]> {
    const rows = await this.db
      .select()
      .from(cadFileCorrections)
      .where(inFile(projectId, cadFileId))
      .orderBy(desc(cadFileCorrections.createdAt), desc(cadFileCorrections.id));
    const names = await this.names(rows);
    return rows.map((row) => this.toRecord(row, names));
  }

  async find(
    projectId: string,
    cadFileId: string,
    correctionId: string,
    options?: { lock?: boolean },
  ): Promise<DrawingCorrectionRecord | null> {
    const query = this.db
      .select()
      .from(cadFileCorrections)
      .where(and(inFile(projectId, cadFileId), eq(cadFileCorrections.id, correctionId)));
    const [row] = await (options?.lock ? query.for('update') : query);
    if (!row) return null;
    return this.toRecord(row, await this.names([row]));
  }

  async countActive(projectId: string, cadFileId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(cadFileCorrections)
      .where(and(inFile(projectId, cadFileId), isNull(cadFileCorrections.withdrawnAt)));
    return row?.n ?? 0;
  }

  async listActiveFrozen(projectId: string, cadFileId: string): Promise<FrozenDrawingCorrection[]> {
    const rows = await this.db
      .select({ id: cadFileCorrections.id, correction: cadFileCorrections.correction })
      .from(cadFileCorrections)
      .where(and(inFile(projectId, cadFileId), isNull(cadFileCorrections.withdrawnAt)))
      .orderBy(asc(cadFileCorrections.createdAt), asc(cadFileCorrections.id));
    return rows.map((row) => ({ id: row.id, correction: row.correction }));
  }

  async handleKinds(
    projectId: string,
    cadFileId: string,
    handles: string[],
  ): Promise<Map<string, Set<HandleKind>>> {
    const found = new Map<string, Set<HandleKind>>();
    if (handles.length === 0) return found;
    const add = (kind: HandleKind, rows: { handle: string }[]) => {
      for (const { handle } of rows) {
        const kinds = found.get(handle) ?? new Set<HandleKind>();
        kinds.add(kind);
        found.set(handle, kinds);
      }
    };
    const [inserts, texts, curves] = await Promise.all([
      this.db
        .select({ handle: cadInserts.handle })
        .from(cadInserts)
        .where(
          and(
            eq(cadInserts.projectId, projectId),
            eq(cadInserts.cadFileId, cadFileId),
            inArray(cadInserts.handle, handles),
          ),
        ),
      this.db
        .select({ handle: cadTexts.handle })
        .from(cadTexts)
        .where(
          and(
            eq(cadTexts.projectId, projectId),
            eq(cadTexts.cadFileId, cadFileId),
            inArray(cadTexts.handle, handles),
          ),
        ),
      this.db
        .select({ handle: cadCurves.handle })
        .from(cadCurves)
        .where(
          and(
            eq(cadCurves.projectId, projectId),
            eq(cadCurves.cadFileId, cadFileId),
            inArray(cadCurves.handle, handles),
          ),
        ),
    ]);
    add('insert', inserts);
    add('text', texts);
    add('curve', curves);
    return found;
  }

  async insert(correction: NewDrawingCorrection): Promise<void> {
    await this.db.insert(cadFileCorrections).values({
      id: correction.id,
      projectId: correction.projectId,
      cadFileId: correction.cadFileId,
      correction: correction.correction,
      problemCode: correction.problem?.code ?? null,
      problemHandle: correction.problem?.handle ?? null,
      createdBy: correction.createdById,
      createdAt: correction.createdAt,
    });
  }

  async withdraw(
    projectId: string,
    cadFileId: string,
    correctionId: string,
    actorId: string,
    at: Date,
  ): Promise<boolean> {
    const updated = await this.db
      .update(cadFileCorrections)
      .set({ withdrawnBy: actorId, withdrawnAt: at })
      .where(
        and(
          inFile(projectId, cadFileId),
          eq(cadFileCorrections.id, correctionId),
          isNull(cadFileCorrections.withdrawnAt),
        ),
      )
      .returning({ id: cadFileCorrections.id });
    return updated.length > 0;
  }
}
