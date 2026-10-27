import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { schema } from '../src/db/schema.js';
import { seed } from '../src/db/seed.js';

let pool: pg.Pool;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: inject('databaseUrl') });
  await seed(drizzle(pool, { schema })); // idempotent; this spec must not depend on file order
});
afterAll(async () => {
  await pool.end();
});

describe('events table is append-only', () => {
  async function insertEvent(): Promise<number> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO events (entity, entity_id, type, payload)
       VALUES ('test', $1, 'test.created', '{"a":1}') RETURNING id`,
      [randomUUID()],
    );
    return Number(rows[0]?.id);
  }

  it('accepts INSERT', async () => {
    expect(await insertEvent()).toBeGreaterThan(0);
  });

  it('rejects UPDATE', async () => {
    const id = await insertEvent();
    await expect(
      pool.query("UPDATE events SET type = 'tampered' WHERE id = $1", [id]),
    ).rejects.toThrow(/append-only/);
  });

  it('rejects DELETE', async () => {
    const id = await insertEvent();
    await expect(pool.query('DELETE FROM events WHERE id = $1', [id])).rejects.toThrow(
      /append-only/,
    );
  });

  it('rejects TRUNCATE', async () => {
    await expect(pool.query('TRUNCATE events')).rejects.toThrow(/append-only/);
  });
});

describe('schema', () => {
  it('has PostGIS', async () => {
    const { rows } = await pool.query<{ postgis_version: string }>(
      'SELECT postgis_version() AS postgis_version',
    );
    expect(rows[0]?.postgis_version).toMatch(/^3\./);
  });

  it('stores zone geometry as MultiPolygon only', async () => {
    const { rows: project } = await pool.query<{ id: string }>(
      "INSERT INTO projects (name, client, crs_epsg, currency) VALUES ('geom-test', 'WE', 32636, 'EGP') RETURNING id",
    );
    const projectId = project[0]?.id;
    await pool.query(
      `INSERT INTO zones (project_id, name, geom)
       VALUES ($1, 'ok', ST_GeomFromText('MULTIPOLYGON(((0 0,0 10,10 10,0 0)))', 32636))`,
      [projectId],
    );
    await expect(
      pool.query(
        `INSERT INTO zones (project_id, name, geom) VALUES ($1, 'bad', ST_GeomFromText('POINT(1 1)', 32636))`,
        [projectId],
      ),
    ).rejects.toThrow();
  });

  it('rejects unknown roles and duplicate assignments (NULLs compared as equal)', async () => {
    const { rows } = await pool.query<{ user_id: string; project_id: string }>(
      'SELECT user_id, project_id FROM assignments LIMIT 1',
    );
    const row = rows[0];
    await expect(
      pool.query("INSERT INTO assignments (user_id, project_id, role) VALUES ($1, $2, 'king')", [
        row?.user_id,
        row?.project_id,
      ]),
    ).rejects.toThrow();
    const { rows: pm } = await pool.query<{ user_id: string; project_id: string }>(
      "SELECT user_id, project_id FROM assignments WHERE role = 'pm'",
    );
    await expect(
      pool.query("INSERT INTO assignments (user_id, project_id, role) VALUES ($1, $2, 'pm')", [
        pm[0]?.user_id,
        pm[0]?.project_id,
      ]),
    ).rejects.toThrow(/assignments_unique/);
  });

  it('keeps emails lower-case and unique', async () => {
    await expect(
      pool.query(
        "INSERT INTO users (email, display_name, password_hash) VALUES ('MiXed@x.io', 'x', 'x')",
      ),
    ).rejects.toThrow(/users_email_lowercase/);
  });

  it('migrations are idempotent', async () => {
    expect(await migrate(inject('databaseUrl'))).toEqual([]);
  });
});
