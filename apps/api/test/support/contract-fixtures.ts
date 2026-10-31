import { randomUUID } from 'node:crypto';
import type pg from 'pg';

/**
 * TEST DATA ONLY: contracts and projects built with SQL, the way the work-order and Phase 3
 * tests need them since work orders come from an approved contract (ADR-028).
 */

export interface FixtureItem {
  code: string;
  description?: string;
  unit?: string;
  quantity: string;
  unitPrice?: string;
  workType?: 'civil' | 'installation' | 'planning';
}

export type FixtureLine = FixtureItem | { heading: string; description?: string };

export interface FixtureContract {
  contractId: string;
  number: string;
  /** Contract item id by item code (headings excluded). */
  itemIds: Record<string, string>;
}

/** An approved EGP contract with the given lines (headings and priced items) in order. */
export async function createApprovedContract(
  pool: pg.Pool,
  lines: readonly FixtureLine[],
  options: { approve?: boolean } = {},
): Promise<FixtureContract> {
  const number = `C-${randomUUID().slice(0, 8)}`;
  const {
    rows: [contract],
  } = await pool.query<{ id: string }>(
    `INSERT INTO contracts (number, name, client, currency)
     VALUES ($1, 'Test contract', 'WE', 'EGP') RETURNING id`,
    [number],
  );
  const contractId = contract?.id ?? '';
  const itemIds: Record<string, string> = {};
  let lineNo = 0;
  for (const line of lines) {
    lineNo += 1;
    if ('heading' in line) {
      await pool.query(
        `INSERT INTO contract_items (contract_id, line_no, kind, code, description)
         VALUES ($1, $2, 'heading', $3, $4)`,
        [contractId, lineNo, line.heading, line.description ?? `Section ${line.heading}`],
      );
      continue;
    }
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO contract_items (contract_id, line_no, kind, code, description, unit, quantity,
                                   unit_price, work_type)
       VALUES ($1, $2, 'item', $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        contractId,
        lineNo,
        line.code,
        line.description ?? `Test item ${line.code}`,
        line.unit ?? 'م.ط',
        line.quantity,
        line.unitPrice ?? '10',
        line.workType ?? 'civil',
      ],
    );
    itemIds[line.code] = rows[0]?.id ?? '';
  }
  if (options.approve ?? true) {
    await pool.query(
      `UPDATE contracts SET status = 'approved', approved_at = now() WHERE id = $1`,
      [contractId],
    );
  }
  return { contractId, number, itemIds };
}

/** A project of the given contract (EGP, like the contract); `null` = a legacy project. */
export async function createProjectIn(
  pool: pg.Pool,
  contractId: string | null,
  name = `Project ${randomUUID().slice(0, 8)}`,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO projects (name, client, crs_epsg, currency, locale, contract_id)
     VALUES ($1, 'WE', 32636, 'EGP', 'ar', $2) RETURNING id`,
    [name, contractId],
  );
  return rows[0]?.id ?? '';
}

/**
 * A work order of `projectId` with lines taken from the contract (`code` → quantity), copying
 * every field from the contract item so the trigger of migration 0008 accepts them.
 */
export async function createWorkOrderFrom(
  pool: pg.Pool,
  projectId: string,
  contract: FixtureContract,
  quantities: Record<string, string>,
): Promise<{ workOrderId: string; itemIdsByCode: Record<string, string> }> {
  const {
    rows: [order],
  } = await pool.query<{ id: string }>(
    `INSERT INTO work_orders (project_id, number, currency) VALUES ($1, $2, 'EGP') RETURNING id`,
    [projectId, `WO-${randomUUID().slice(0, 8)}`],
  );
  const workOrderId = order?.id ?? '';
  const itemIdsByCode: Record<string, string> = {};
  let lineNo = 0;
  for (const [code, quantity] of Object.entries(quantities)) {
    lineNo += 1;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO work_order_items (project_id, work_order_id, line_no, code, description, unit,
                                     quantity, unit_price, work_type, contract_id, contract_item_id)
       SELECT $1, $2, $3, ci.code, ci.description, ci.unit, $4, ci.unit_price, ci.work_type,
              ci.contract_id, ci.id
       FROM contract_items ci WHERE ci.id = $5
       RETURNING id`,
      [projectId, workOrderId, lineNo, quantity, contract.itemIds[code]],
    );
    itemIdsByCode[code] = rows[0]?.id ?? '';
  }
  return { workOrderId, itemIdsByCode };
}
