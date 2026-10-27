import { MeResponseSchema } from '@ftth/shared';
import { eq } from 'drizzle-orm';
import type { Database } from '../../../db/db.module.js';
import { users } from '../../../db/schema.js';
import type { User, UserRepository } from '../domain/user.js';

function toUser(row: typeof users.$inferSelect): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    passwordHash: row.passwordHash,
    locale: MeResponseSchema.shape.locale.parse(row.locale),
    isAdmin: row.isAdmin,
    isActive: row.isActive,
  };
}

export class DrizzleUserRepository implements UserRepository {
  constructor(private readonly db: Database) {}

  async findByEmail(email: string): Promise<User | null> {
    const [row] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    return row ? toUser(row) : null;
  }

  async findById(id: string): Promise<User | null> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return row ? toUser(row) : null;
  }
}
