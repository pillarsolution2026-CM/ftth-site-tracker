import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  cadCurves,
  cadFiles,
  cadInserts,
  cadLayers,
  cadMappings,
  cadTexts,
  contractAttachments,
  contractItems,
  contracts,
  designFeatures,
  projects,
  designRevisions,
  features,
  revisionDiffItems,
  textLinks,
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

describe('Drizzle schema matches migrations 0003, 0005 and 0007', () => {
  it.each([
    projects,
    contracts,
    contractItems,
    contractAttachments,
    workOrders,
    workOrderItems,
    workOrderAttachments,
    cadFiles,
    cadLayers,
    cadInserts,
    cadTexts,
    cadCurves,
    cadMappings,
    designRevisions,
    features,
    designFeatures,
    textLinks,
    revisionDiffItems,
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
