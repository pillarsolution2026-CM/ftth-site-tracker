import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../../db/db.module.js';
import { refreshTokens } from '../../../db/schema.js';
import type {
  NewRefreshToken,
  RefreshTokenRecord,
  RefreshTokenRepository,
} from '../domain/refresh-token.js';

export class DrizzleRefreshTokenRepository implements RefreshTokenRepository {
  constructor(private readonly db: Database) {}

  async insert(token: NewRefreshToken): Promise<void> {
    await this.db.insert(refreshTokens).values(token);
  }

  async findByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    const [row] = await this.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .limit(1);
    return row ?? null;
  }

  async rotate(currentId: string, next: NewRefreshToken, now: Date): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      // The guarded UPDATE is the atomic "claim": only one concurrent request can win it.
      const claimed = await tx
        .update(refreshTokens)
        .set({ rotatedAt: now })
        .where(
          and(
            eq(refreshTokens.id, currentId),
            isNull(refreshTokens.rotatedAt),
            isNull(refreshTokens.revokedAt),
          ),
        )
        .returning({ id: refreshTokens.id });
      if (claimed.length === 0) return false;
      await tx.insert(refreshTokens).values(next);
      return true;
    });
  }

  async revokeFamily(familyId: string, now: Date): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: now })
      .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
  }
}
