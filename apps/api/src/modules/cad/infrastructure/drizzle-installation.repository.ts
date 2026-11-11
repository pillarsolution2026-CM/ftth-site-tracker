import type { FrozenInstallation } from '@ftth/shared';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DbHandle } from '../../../db/db.module.js';
import {
  cadCurves,
  cadFileInstallationAnswers,
  cadFileTrenchMarks,
  users,
} from '../../../db/schema.js';
import type {
  InstallationAnswerRow,
  InstallationRepository,
  NewInstallationAnswer,
  NewTrenchMark,
  TrenchMarkRecord,
} from '../domain/installation.js';

type AnswerRow = typeof cadFileInstallationAnswers.$inferSelect;
type MarkRow = typeof cadFileTrenchMarks.$inferSelect;
type Names = Map<string, string>;

const answersOf = (projectId: string, cadFileId: string) =>
  and(
    eq(cadFileInstallationAnswers.projectId, projectId),
    eq(cadFileInstallationAnswers.cadFileId, cadFileId),
  );
const marksOf = (projectId: string, cadFileId: string) =>
  and(eq(cadFileTrenchMarks.projectId, projectId), eq(cadFileTrenchMarks.cadFileId, cadFileId));

/** Every query carries `project_id` (IDOR defence). */
export class DrizzleInstallationRepository implements InstallationRepository {
  constructor(private readonly db: DbHandle) {}

  private async names(ids: (string | null)[]): Promise<Names> {
    const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
    if (wanted.length === 0) return new Map();
    const found = await this.db
      .select({ id: users.id, name: users.displayName })
      .from(users)
      .where(inArray(users.id, wanted));
    return new Map(found.map((user) => [user.id, user.name]));
  }

  private person(id: string | null, names: Names) {
    return id ? { id, name: names.get(id) ?? '' } : null;
  }

  private toAnswer(row: AnswerRow, names: Names): InstallationAnswerRow {
    return {
      id: row.id,
      projectId: row.projectId,
      cadFileId: row.cadFileId,
      answer: row.answer,
      createdBy: this.person(row.createdBy, names),
      createdAt: row.createdAt,
    };
  }

  private toMark(row: MarkRow, names: Names): TrenchMarkRecord {
    return {
      id: row.id,
      projectId: row.projectId,
      cadFileId: row.cadFileId,
      routeHandle: row.routeHandle,
      lengthM: row.lengthM, // numeric(9,3) text: "12.500"
      createdBy: this.person(row.createdBy, names),
      createdAt: row.createdAt,
      withdrawnBy: this.person(row.withdrawnBy, names),
      withdrawnAt: row.withdrawnAt,
    };
  }

  async listAnswers(projectId: string, cadFileId: string): Promise<InstallationAnswerRow[]> {
    const rows = await this.db
      .select()
      .from(cadFileInstallationAnswers)
      .where(answersOf(projectId, cadFileId))
      .orderBy(desc(cadFileInstallationAnswers.createdAt), desc(cadFileInstallationAnswers.id));
    const names = await this.names(rows.map((row) => row.createdBy));
    return rows.map((row) => this.toAnswer(row, names));
  }

  async countAnswers(projectId: string, cadFileId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(cadFileInstallationAnswers)
      .where(answersOf(projectId, cadFileId));
    return row?.n ?? 0;
  }

  async insertAnswer(answer: NewInstallationAnswer): Promise<void> {
    await this.db.insert(cadFileInstallationAnswers).values({
      id: answer.id,
      projectId: answer.projectId,
      cadFileId: answer.cadFileId,
      answer: answer.answer,
      createdBy: answer.createdById,
      createdAt: answer.createdAt,
    });
  }

  async listMarks(projectId: string, cadFileId: string): Promise<TrenchMarkRecord[]> {
    const rows = await this.db
      .select()
      .from(cadFileTrenchMarks)
      .where(marksOf(projectId, cadFileId))
      .orderBy(desc(cadFileTrenchMarks.createdAt), desc(cadFileTrenchMarks.id));
    const names = await this.names(rows.flatMap((row) => [row.createdBy, row.withdrawnBy]));
    return rows.map((row) => this.toMark(row, names));
  }

  async findMark(
    projectId: string,
    cadFileId: string,
    markId: string,
    options?: { lock?: boolean },
  ): Promise<TrenchMarkRecord | null> {
    const query = this.db
      .select()
      .from(cadFileTrenchMarks)
      .where(and(marksOf(projectId, cadFileId), eq(cadFileTrenchMarks.id, markId)));
    const [row] = await (options?.lock ? query.for('update') : query);
    if (!row) return null;
    return this.toMark(row, await this.names([row.createdBy, row.withdrawnBy]));
  }

  async countActiveMarks(projectId: string, cadFileId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(cadFileTrenchMarks)
      .where(and(marksOf(projectId, cadFileId), isNull(cadFileTrenchMarks.withdrawnAt)));
    return row?.n ?? 0;
  }

  async countAllMarks(projectId: string, cadFileId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(cadFileTrenchMarks)
      .where(marksOf(projectId, cadFileId));
    return row?.n ?? 0;
  }

  async insertMark(mark: NewTrenchMark): Promise<void> {
    await this.db.insert(cadFileTrenchMarks).values({
      id: mark.id,
      projectId: mark.projectId,
      cadFileId: mark.cadFileId,
      routeHandle: mark.routeHandle,
      lengthM: mark.lengthM,
      createdBy: mark.createdById,
      createdAt: mark.createdAt,
    });
  }

  async withdrawMark(
    projectId: string,
    cadFileId: string,
    markId: string,
    actorId: string,
    at: Date,
  ): Promise<boolean> {
    const updated = await this.db
      .update(cadFileTrenchMarks)
      .set({ withdrawnBy: actorId, withdrawnAt: at })
      .where(
        and(
          marksOf(projectId, cadFileId),
          eq(cadFileTrenchMarks.id, markId),
          isNull(cadFileTrenchMarks.withdrawnAt),
        ),
      )
      .returning({ id: cadFileTrenchMarks.id });
    return updated.length > 0;
  }

  async curveExists(projectId: string, cadFileId: string, handle: string): Promise<boolean> {
    const rows = await this.db
      .select({ handle: cadCurves.handle })
      .from(cadCurves)
      .where(
        and(
          eq(cadCurves.projectId, projectId),
          eq(cadCurves.cadFileId, cadFileId),
          eq(cadCurves.handle, handle),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async frozen(projectId: string, cadFileId: string): Promise<FrozenInstallation> {
    const [latest] = await this.db
      .select({ id: cadFileInstallationAnswers.id, answer: cadFileInstallationAnswers.answer })
      .from(cadFileInstallationAnswers)
      .where(answersOf(projectId, cadFileId))
      .orderBy(desc(cadFileInstallationAnswers.createdAt), desc(cadFileInstallationAnswers.id))
      .limit(1);
    const marks = await this.db
      .select({
        id: cadFileTrenchMarks.id,
        routeHandle: cadFileTrenchMarks.routeHandle,
        lengthM: cadFileTrenchMarks.lengthM,
      })
      .from(cadFileTrenchMarks)
      .where(and(marksOf(projectId, cadFileId), isNull(cadFileTrenchMarks.withdrawnAt)))
      .orderBy(asc(cadFileTrenchMarks.createdAt), asc(cadFileTrenchMarks.id));
    return {
      answer: latest?.answer ?? null,
      answerId: latest?.id ?? null,
      marks: marks.map((m) => ({ id: m.id, routeHandle: m.routeHandle, lengthM: m.lengthM })),
    };
  }
}
