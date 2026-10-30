import { randomUUID } from 'node:crypto';
import { verify } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createAdmin, resetAdminPassword } from '../src/db/create-admin.js';
import { refreshTokens, schema, users } from '../src/db/schema.js';

let pool: pg.Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(() => {
  pool = new pg.Pool({ connectionString: inject('databaseUrl') });
  db = drizzle(pool, { schema });
});
afterAll(async () => {
  await pool.end();
});

describe('createAdmin', () => {
  it('creates an admin with an argon2 hash and a lower-case email', async () => {
    const email = `Ops-${randomUUID()}@Example.com`;
    const result = await createAdmin(db, { email, password: 'staging-pass-123' });

    expect(result.created).toBe(true);
    const [row] = await db.select().from(users).where(eq(users.id, result.id));
    expect(row?.email).toBe(email.toLowerCase());
    expect(row?.isAdmin).toBe(true);
    expect(await verify(row?.passwordHash ?? '', 'staging-pass-123')).toBe(true);
  });

  it('never overwrites an existing user', async () => {
    const email = `ops-${randomUUID()}@example.com`;
    const first = await createAdmin(db, { email, password: 'first-password-1' });
    const second = await createAdmin(db, { email, password: 'second-password-2' });

    expect(second).toEqual({ created: false, id: first.id });
    const [row] = await db.select().from(users).where(eq(users.id, first.id));
    expect(await verify(row?.passwordHash ?? '', 'first-password-1')).toBe(true);
  });

  it('rejects a short password', async () => {
    await expect(
      createAdmin(db, { email: `ops-${randomUUID()}@example.com`, password: 'short' }),
    ).rejects.toThrow();
  });
});

describe('resetAdminPassword', () => {
  it('replaces the password of an existing admin and revokes its sessions', async () => {
    const email = `ops-${randomUUID()}@example.com`;
    const { id } = await createAdmin(db, { email, password: 'lost-password-1' });
    await db.insert(refreshTokens).values({
      userId: id,
      familyId: randomUUID(),
      tokenHash: randomUUID(),
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    const result = await resetAdminPassword(db, { email: email.toUpperCase(), password: 'new-password-22' });

    expect(result).toEqual({ updated: true });
    const [row] = await db.select().from(users).where(eq(users.id, id));
    expect(await verify(row?.passwordHash ?? '', 'new-password-22')).toBe(true);
    expect(await verify(row?.passwordHash ?? '', 'lost-password-1')).toBe(false);
    const tokens = await db.select().from(refreshTokens).where(eq(refreshTokens.userId, id));
    expect(tokens.every((token) => token.revokedAt !== null)).toBe(true);
  });

  it('does not touch a user who is not an admin', async () => {
    const email = `user-${randomUUID()}@example.com`;
    const [user] = await db
      .insert(users)
      .values({ email, displayName: 'User', passwordHash: 'unchanged-hash' })
      .returning({ id: users.id });

    const result = await resetAdminPassword(db, { email, password: 'new-password-22' });

    expect(result).toEqual({ updated: false });
    const [row] = await db.select().from(users).where(eq(users.id, user?.id ?? ''));
    expect(row?.passwordHash).toBe('unchanged-hash');
  });

  it('reports an unknown email without creating anyone', async () => {
    const email = `ghost-${randomUUID()}@example.com`;

    expect(await resetAdminPassword(db, { email, password: 'new-password-22' })).toEqual({ updated: false });
    expect(await db.select().from(users).where(eq(users.email, email))).toHaveLength(0);
  });

  it('rejects a short password', async () => {
    await expect(
      resetAdminPassword(db, { email: `ops-${randomUUID()}@example.com`, password: 'short' }),
    ).rejects.toThrow();
  });
});
