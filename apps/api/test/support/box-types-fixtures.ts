import type pg from 'pg';
import { createApprovedContract, createWorkOrderFrom } from './contract-fixtures.js';

/**
 * TEST DATA ONLY (ADR-043): a Secondary is published only when it was mapped with text roles and its
 * box types are clear. Fixtures that build a Secondary draft with SQL call `makeBoxTypesClear` on
 * it: roles mapping frozen, an empty shape gallery (no boxes to type) and a work order in the
 * project (a project without one is WORK_ORDER_MISSING). A General is left untouched.
 */
export const SECONDARY_ROLES_RULES = [
  { source: 'layer', layer: 'BOXES', target: 'box', textRoles: ['box_cable_type'] },
];

const EMPTY_GALLERY = { version: 1, boxCount: 0, shapeCount: 0, shapes: [], boxesWithoutShape: 0 };

export async function ensureWorkOrder(pool: pg.Pool, projectId: string): Promise<void> {
  const { rowCount } = await pool.query('SELECT 1 FROM work_orders WHERE project_id = $1', [
    projectId,
  ]);
  if (rowCount && rowCount > 0) return;
  const contract = await createApprovedContract(pool, [{ code: 'BX1', quantity: '1000' }]);
  await pool.query('UPDATE projects SET contract_id = $2 WHERE id = $1', [
    projectId,
    contract.contractId,
  ]);
  await createWorkOrderFrom(pool, projectId, contract, { BX1: '1' });
}

export async function makeBoxTypesClear(pool: pg.Pool, revisionId: string): Promise<void> {
  const { rows } = await pool.query<{ project_id: string; drawing_kind: string }>(
    'SELECT project_id, drawing_kind FROM design_revisions WHERE id = $1',
    [revisionId],
  );
  const row = rows[0];
  if (row?.drawing_kind !== 'secondary') return;
  await ensureWorkOrder(pool, row.project_id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE design_revisions DISABLE TRIGGER design_revisions_immutable');
    await client.query(
      `UPDATE design_revisions SET rules = $2::jsonb, box_types = '{"choices":[]}'::jsonb,
              box_shapes = $3::jsonb WHERE id = $1`,
      [revisionId, JSON.stringify(SECONDARY_ROLES_RULES), JSON.stringify(EMPTY_GALLERY)],
    );
    await client.query('ALTER TABLE design_revisions ENABLE TRIGGER design_revisions_immutable');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
