import {
  FeatureTypeSchema,
  UpdateStatusSchema,
  type PortalRegistration,
  type PortalWork,
} from '@ftth/shared';
import { sql } from 'drizzle-orm';
import { toDecimalText } from '../../../common/decimal-text.js';
import type { DbHandle } from '../../../db/db.module.js';
import { rowsOf } from '../../../db/sql.js';
import type {
  ContractorAccountContext,
  ContractorPortalRepository,
  PortalValueTotal,
} from '../domain/contractor-account.js';

/**
 * Raw SQL on purpose: values are `quantity × price` in PostgreSQL numeric (exact, never a float),
 * and the day of a work line is cut in SQL. Every statement is bound to ONE contractor id, taken
 * from the logged-in account; the client (contract) price, photos, supervisors, devices, GPS and
 * notes are never selected. Dates are formatted as text so the driver never turns them into JS Dates.
 */

/** Work of the contractor with its price in force on the work date of the update (ADR-057). */
function workLines(contractorId: string) {
  return sql`
    SELECT l.update_id, l.line_no, r.id AS registration_id, cl.id AS contractor_line_id,
           u.feature_type, df.code, u.status,
           CASE WHEN u.status = 'rejected' THEN u.review_reason END AS review_reason,
           u.captured_at,
           to_char(u.work_date, 'YYYY-MM-DD') AS work_date,
           l.quantity::text AS quantity,
           price.unit_price::text AS unit_price,
           (l.quantity * price.unit_price)::text AS value,
           o.currency
    FROM contractor_registrations r
    JOIN contractor_lines cl ON cl.registration_id = r.id AND cl.project_id = r.project_id
    JOIN execution_update_lines l
      ON l.contractor_line_id = cl.id AND l.project_id = cl.project_id AND l.role = 'work'
    JOIN execution_updates u ON u.project_id = l.project_id AND u.id = l.update_id
    JOIN work_orders o ON o.project_id = r.project_id AND o.id = r.work_order_id
    LEFT JOIN design_features df ON df.revision_id = u.design_revision_id AND df.feature_id = u.feature_id
    CROSS JOIN LATERAL (SELECT u.work_date AS day) wd
    CROSS JOIN LATERAL (
      -- His price in force that day: the latest one starting on or before it. ADR-057: no work
      -- predates his registration (his first price), so the first-price fallback is only a guard.
      SELECT p.unit_price FROM contractor_line_prices p
      WHERE p.contractor_line_id = cl.id
      ORDER BY (p.effective_from > wd.day),
               CASE WHEN p.effective_from <= wd.day THEN p.effective_from END DESC,
               p.effective_from ASC
      LIMIT 1
    ) price
    WHERE r.contractor_id = ${contractorId}`;
}

interface RegistrationRow {
  registration_id: string;
  project_id: string;
  project_name: string;
  work_order_number: string;
  currency: string;
  registered_on: string;
}

interface LineRow {
  registration_id: string;
  contractor_line_id: string;
  code: string;
  description: string;
  unit: string;
  scope: string | null;
  quantity: string;
  recorded_quantity: string;
}

interface PriceRow {
  contractor_line_id: string;
  effective_from: string;
  unit_price: string;
}

interface WorkRow {
  update_id: string;
  line_no: number;
  registration_id: string;
  contractor_line_id: string;
  /** NULL on a planning update recorded on a drawing (ADR-056): it has no element. */
  feature_type: string | null;
  code: string | null;
  status: string;
  review_reason: string | null;
  work_date: string;
  quantity: string;
  unit_price: string;
  value: string;
}

export class DrizzleContractorPortalRepository implements ContractorPortalRepository {
  constructor(private readonly db: DbHandle) {}

  async findActiveAccount(userId: string): Promise<ContractorAccountContext | null> {
    const [row] = await rowsOf<{ contractor_id: string; name: string }>(
      this.db,
      sql`SELECT a.contractor_id, c.name
          FROM contractor_accounts a
          JOIN users u ON u.id = a.user_id AND u.is_active
          JOIN contractors c ON c.id = a.contractor_id
          WHERE a.user_id = ${userId}`,
    );
    return row ? { userId, contractorId: row.contractor_id, contractorName: row.name } : null;
  }

  async registrations(contractorId: string): Promise<PortalRegistration[]> {
    const registrations = await rowsOf<RegistrationRow>(
      this.db,
      sql`SELECT r.id AS registration_id, r.project_id, p.name AS project_name,
                 o.number AS work_order_number, o.currency,
                 to_char(r.registered_on, 'YYYY-MM-DD') AS registered_on
          FROM contractor_registrations r
          JOIN projects p ON p.id = r.project_id
          JOIN work_orders o ON o.project_id = r.project_id AND o.id = r.work_order_id
          WHERE r.contractor_id = ${contractorId}
          ORDER BY r.registered_on, r.created_at, r.id`,
    );
    // Pending + approved work counts toward the line quantity; rejected work frees it (ADR-052).
    const lines = await rowsOf<LineRow>(
      this.db,
      sql`SELECT cl.registration_id, cl.id AS contractor_line_id, i.code, i.description, i.unit,
                 cl.scope, cl.quantity::text AS quantity,
                 COALESCE((
                   SELECT sum(l.quantity)
                   FROM execution_update_lines l
                   JOIN execution_updates u ON u.project_id = l.project_id AND u.id = l.update_id
                   WHERE l.contractor_line_id = cl.id AND u.status <> 'rejected'
                 ), 0)::text AS recorded_quantity
          FROM contractor_registrations r
          JOIN contractor_lines cl ON cl.registration_id = r.id AND cl.project_id = r.project_id
          JOIN work_order_items i ON i.project_id = cl.project_id AND i.id = cl.work_order_item_id
          WHERE r.contractor_id = ${contractorId}
          ORDER BY i.line_no, cl.scope NULLS FIRST, cl.id`,
    );
    const prices = await rowsOf<PriceRow>(
      this.db,
      sql`SELECT p.contractor_line_id, to_char(p.effective_from, 'YYYY-MM-DD') AS effective_from,
                 p.unit_price::text AS unit_price
          FROM contractor_registrations r
          JOIN contractor_lines cl ON cl.registration_id = r.id AND cl.project_id = r.project_id
          JOIN contractor_line_prices p ON p.contractor_line_id = cl.id
          WHERE r.contractor_id = ${contractorId}
          ORDER BY p.effective_from`,
    );

    const pricesByLine = new Map<string, { effectiveFrom: string; unitPrice: string }[]>();
    for (const price of prices) {
      const list = pricesByLine.get(price.contractor_line_id) ?? [];
      list.push({
        effectiveFrom: price.effective_from,
        unitPrice: toDecimalText(price.unit_price),
      });
      pricesByLine.set(price.contractor_line_id, list);
    }
    return registrations.map((registration) => ({
      registrationId: registration.registration_id,
      projectId: registration.project_id,
      projectName: registration.project_name,
      workOrderNumber: registration.work_order_number,
      currency: registration.currency,
      registeredOn: registration.registered_on,
      lines: lines
        .filter((line) => line.registration_id === registration.registration_id)
        .map((line) => ({
          contractorLineId: line.contractor_line_id,
          code: line.code,
          description: line.description,
          unit: line.unit,
          scope: line.scope,
          quantity: toDecimalText(line.quantity),
          prices: pricesByLine.get(line.contractor_line_id) ?? [],
          recordedQuantity: toDecimalText(line.recorded_quantity),
        })),
    }));
  }

  async work(contractorId: string): Promise<PortalWork[]> {
    const rows = await rowsOf<WorkRow>(
      this.db,
      sql`SELECT w.update_id, w.line_no, w.registration_id, w.contractor_line_id, w.feature_type,
                 w.code, w.status, w.review_reason, w.work_date, w.quantity, w.unit_price, w.value
          FROM (${workLines(contractorId)}) w
          ORDER BY w.work_date DESC, w.captured_at DESC, w.update_id DESC, w.line_no DESC`,
    );
    // ADR-056: a «التخطيط» update has no element (element null), and is listed like the others.
    return rows.map((row) => ({
      key: `${row.update_id}:${row.line_no}`,
      registrationId: row.registration_id,
      contractorLineId: row.contractor_line_id,
      element:
        row.feature_type === null
          ? null
          : { featureType: FeatureTypeSchema.parse(row.feature_type), code: row.code },
      workDate: row.work_date,
      quantity: toDecimalText(row.quantity),
      status: UpdateStatusSchema.parse(row.status),
      reviewReason: row.review_reason,
      unitPrice: toDecimalText(row.unit_price),
      value: toDecimalText(row.value),
    }));
  }

  async valueTotals(contractorId: string): Promise<PortalValueTotal[]> {
    const rows = await rowsOf<{ currency: string; status: string; total: string }>(
      this.db,
      sql`SELECT w.currency, w.status, sum(w.value::numeric)::text AS total
          FROM (${workLines(contractorId)}) w
          GROUP BY w.currency, w.status`,
    );
    return rows.map((row) => ({
      currency: row.currency,
      status: UpdateStatusSchema.parse(row.status),
      total: row.total,
    }));
  }
}
