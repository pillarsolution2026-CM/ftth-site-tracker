import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  cadCurves,
  cadFiles,
  cadInserts,
  cadLayers,
  cadTexts,
  workOrderAttachments,
  workOrderItems,
  workOrders,
} from '../src/db/schema.js';

let pool: pg.Pool;
beforeAll(() => {
  pool = new pg.Pool({ connectionString: inject('databaseUrl') });
});
afterAll(async () => {
  await pool.end();
});

describe('Drizzle schema matches migration 0003', () => {
  it.each([
    workOrders,
    workOrderItems,
    workOrderAttachments,
    cadFiles,
    cadLayers,
    cadInserts,
    cadTexts,
    cadCurves,
  ] as PgTable[])('table %#: same columns as the database', async (table) => {
    const config = getTableConfig(table);
    const { rows } = await pool.query<{ column_name: string }>(
      'SELECT column_name FROM information_schema.columns WHERE table_name = $1',
      [config.name],
    );
    expect(config.columns.map((column) => column.name).sort()).toEqual(
      rows.map((row) => row.column_name).sort(),
    );
  });
});
