import { randomUUID } from 'node:crypto';
import { verify } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createAdmin } from '../src/db/create-admin.js';
import { schema, users } from '../src/db/schema.js';

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
