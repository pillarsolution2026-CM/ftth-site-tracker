import { randomUUID } from 'node:crypto';
import type pg from 'pg';

type Run = (text: string, values: unknown[]) => Promise<unknown>;

/**
 * TEST DATA ONLY. Inserts a `site_drawings` row (ADR-049 part B) that a SQL-inserted `cad_files`
 * row points at. `siteId` null makes it an unassigned drawing («بدون موقع»), as before sites.
 */
export async function insertDrawing(
  run: Run,
  projectId: string,
  kind: 'general' | 'secondary' = 'general',
  options: { siteId?: string | null; ordinal?: number; id?: string } = {},
): Promise<string> {
  const id = options.id ?? randomUUID();
  await run(
    `INSERT INTO site_drawings (id, project_id, site_id, drawing_kind, ordinal)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, projectId, options.siteId ?? null, kind, options.ordinal ?? 1],
  );
  return id;
}

/**
 * TEST DATA ONLY. A site of the project's work order (the work order and the site are created when
 * missing), named «موقع الاختبار». Returns the site id.
 */
export async function ensureSite(pool: pg.Pool, projectId: string): Promise<string> {
  const existing = await pool.query<{ id: string }>(
    `SELECT s.id FROM work_order_sites s WHERE s.project_id = $1 AND s.name_key = 'موقع الاختبار'`,
    [projectId],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  let order = (
    await pool.query<{ id: string }>('SELECT id FROM work_orders WHERE project_id = $1', [
      projectId,
    ])
  ).rows[0]?.id;
  if (!order) {
    order = randomUUID();
    await pool.query(
      `INSERT INTO work_orders (id, project_id, number, currency)
       SELECT $1, id, 'WO-SITES', currency FROM projects WHERE id = $2`,
      [order, projectId],
    );
  }
  const site = randomUUID();
  await pool.query(
    `INSERT INTO work_order_sites (id, project_id, work_order_id, name, name_key, position)
     VALUES ($1, $2, $3, 'موقع الاختبار', 'موقع الاختبار',
             1 + COALESCE((SELECT max(position) FROM work_order_sites WHERE work_order_id = $3), 0))`,
    [site, projectId, order],
  );
  return site;
}

/**
 * TEST DATA ONLY. Links the project's unassigned drawings to one site as the PM's «اربط بموقع»
 * does (a General only when the site has none; a Secondary takes the next number). Idempotent.
 */
export async function linkDrawingsToSite(pool: pg.Pool, projectId: string): Promise<string> {
  const site = await ensureSite(pool, projectId);
  const unassigned = await pool.query<{ id: string; drawing_kind: string }>(
    `SELECT id, drawing_kind FROM site_drawings
     WHERE project_id = $1 AND site_id IS NULL AND withdrawn_at IS NULL
     ORDER BY drawing_kind, created_at, id`,
    [projectId],
  );
  for (const drawing of unassigned.rows) {
    if (drawing.drawing_kind === 'general') {
      const has = await pool.query(
        `SELECT 1 FROM site_drawings WHERE site_id = $1 AND drawing_kind = 'general'
         AND withdrawn_at IS NULL`,
        [site],
      );
      if (has.rowCount) continue;
    }
    await pool.query(
      `UPDATE site_drawings SET site_id = $2,
              ordinal = CASE WHEN drawing_kind = 'general' THEN 1 ELSE
                1 + COALESCE((SELECT max(ordinal) FROM site_drawings
                              WHERE site_id = $2 AND drawing_kind = 'secondary'), 0) END
       WHERE id = $1`,
      [drawing.id, site],
    );
  }
  return site;
}

/**
 * TEST DATA ONLY. The upload query (ADR-049 part B) of the project's test site: a new version of
 * the first active drawing of the kind when there is one, else a new drawing.
 */
export async function uploadQuery(
  pool: pg.Pool,
  projectId: string,
  kind: 'general' | 'secondary',
): Promise<string> {
  const site = await ensureSite(pool, projectId);
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM site_drawings WHERE site_id = $1 AND drawing_kind = $2
     AND withdrawn_at IS NULL ORDER BY ordinal LIMIT 1`,
    [site, kind],
  );
  const drawing = existing.rows[0];
  return drawing
    ? `?siteId=${site}&kind=${kind}&target=new_version&drawingId=${drawing.id}`
    : `?siteId=${site}&kind=${kind}&target=new_drawing`;
}

/**
 * TEST DATA ONLY. A new version of a file: the older one is marked superseded first (the reference
 * to the newer file is checked at commit), then the newer one is inserted in the same drawing, all
 * in one transaction. Returns the id of the new file.
 */
export async function supersedeByNewFile(pool: pg.Pool, oldId: string): Promise<string> {
  const newId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE cad_files SET superseded_at = now(), superseded_by = $2 WHERE id = $1',
      [oldId, newId],
    );
    await client.query(
      `INSERT INTO cad_files (id, project_id, original_name, format, size_bytes, sha256, storage_key,
                              status, current_job_id, processed_at, drawing_kind, drawing_id)
       SELECT $2::uuid, project_id, 'v2.dxf', 'dxf', 1, repeat('a', 64),
              'projects/' || project_id || '/cad/' || $2::text || '/o.dxf', 'processed',
              gen_random_uuid(), now(), drawing_kind, drawing_id
       FROM cad_files WHERE id = $1`,
      [oldId, newId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return newId;
}
