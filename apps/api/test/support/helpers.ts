import { hash } from '@node-rs/argon2';
import { TokenPairSchema, type Role } from '@ftth/shared';
import request from 'supertest';
import type pg from 'pg';
import type { TestContext } from './test-app.js';

export const SEED_LOGINS = {
  admin: ['admin@ftth.local', 'Admin#12345'],
  pm: ['pm@ftth.local', 'Pm#123456'],
  supervisor: ['supervisor@ftth.local', 'Super#12345'],
} as const;

export async function loginAs(ctx: TestContext, email: string, password: string): Promise<string> {
  const res = await request(ctx.app.getHttpServer()).post('/auth/login').send({ email, password });
  return TokenPairSchema.parse(res.body).accessToken;
}

export async function projectIds(pool: pg.Pool): Promise<{ a: string; b: string; zone: string }> {
  const { rows } = await pool.query<{ id: string; name: string }>('SELECT id, name FROM projects');
  const a = rows.find((row) => row.name === 'القطاع الأول – قليوب')?.id ?? '';
  const b = rows.find((row) => row.name === 'Test Project B')?.id ?? '';
  const zone = (await pool.query<{ id: string }>('SELECT id FROM zones WHERE project_id = $1', [a]))
    .rows[0]?.id;
  return { a, b, zone: zone ?? '' };
}

/** Creates (or reuses) a user with one role in a project; project-wide roles need no zone. */
export async function ensureMember(
  pool: pg.Pool,
  input: { email: string; password: string; role: Role; projectId: string; zoneId?: string },
): Promise<void> {
  const existing = await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [
    input.email,
  ]);
  let userId = existing.rows[0]?.id;
  if (!userId) {
    const created = await pool.query<{ id: string }>(
      `INSERT INTO users (email, display_name, password_hash, locale)
       VALUES ($1, $1, $2, 'ar') RETURNING id`,
      [input.email, await hash(input.password)],
    );
    userId = created.rows[0]?.id;
  }
  await pool.query(
    `INSERT INTO assignments (user_id, project_id, role, zone_id)
     SELECT $1, $2, $3, $4
     WHERE NOT EXISTS (SELECT 1 FROM assignments WHERE user_id = $1 AND project_id = $2 AND role = $3)`,
    [userId, input.projectId, input.role, input.zoneId ?? null],
  );
}

export async function eventTypes(pool: pg.Pool, entityId: string): Promise<string[]> {
  const { rows } = await pool.query<{ type: string }>(
    'SELECT type FROM events WHERE entity_id = $1 ORDER BY id',
    [entityId],
  );
  return rows.map((row) => row.type);
}
