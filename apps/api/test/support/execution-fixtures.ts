import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { ensureMember, loginAs, SEED_LOGINS } from './helpers.js';
import type { TestContext } from './test-app.js';

/**
 * TEST DATA ONLY. A fresh project with what Phase 3 needs and Phase 2 has not built yet: zones
 * with polygons, a published revision (the CAD worker's side simulated with SQL, as in the
 * design-revision tests) and a work order. Never used outside the integration tests.
 */

/** Somewhere in Qalyub, UTM 36N (EPSG:32636), metres. */
export const E0 = 330_000;
export const N0 = 3_340_000;

export interface ExecutionFixture {
  projectId: string;
  otherProjectId: string;
  zoneA: string;
  zoneB: string;
  revisionId: string;
  /** Route from (E0, N0) to (E0 + 100, N0), inside zone A. */
  routeA: string;
  /** Box at (E0 + 50, N0 + 5), inside zone A. */
  boxA: string;
  /** Box at (E0 + 1000, N0 + 1000), inside zone B only. */
  boxB: string;
  /** Work-order items: civil 100 m, civil 10 pcs, installation 5 pcs. */
  items: { civilMetres: string; civilPieces: string; installation: string };
  /** Item in another project. */
  foreignItem: string;
  tokens: {
    admin: string;
    pm: string;
    qc: string;
    supervisorA: string;
    supervisorA2: string;
    supervisorB: string;
    contractor: string;
  };
  userIds: { supervisorA: string; supervisorA2: string; supervisorB: string };
}

const square = (e: number, n: number, size: number) =>
  `ST_Multi(ST_MakeEnvelope(${e}, ${n}, ${e + size}, ${n + size}, 32636))`;

async function insertProject(pool: pg.Pool, name: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO projects (name, client, crs_epsg, currency, locale)
     VALUES ($1, 'WE', 32636, 'EGP', 'ar') RETURNING id`,
    [name],
  );
  return rows[0]?.id ?? '';
}

/** A revision built and published, with the given features (WKT in EPSG:32636). */
export async function publishRevision(
  pool: pg.Pool,
  projectId: string,
  features: { id: string; type: string; wkt: string; code?: string; isNew: boolean }[],
  revNo: number,
): Promise<string> {
  const fileId = randomUUID();
  await pool.query(
    `INSERT INTO cad_files (id, project_id, original_name, format, size_bytes, sha256, storage_key,
                            status, current_job_id, processed_at)
     VALUES ($1, $2, 'plan.dxf', 'dxf', 100, repeat('a', 64), $3, 'processed', $4, now())`,
    [fileId, projectId, `projects/${projectId}/cad/${fileId}/original.dxf`, randomUUID()],
  );
  const revisionId = randomUUID();
  await pool.query(
    `INSERT INTO design_revisions (id, project_id, cad_file_id, status, current_job_id, rules,
                                   mapping_version, crs_epsg, drawing_unit, metres_per_unit)
     VALUES ($1, $2, $3, 'building', $4, '[]', 1, 32636, 'm', 1)`,
    [revisionId, projectId, fileId, randomUUID()],
  );
  for (const feature of features) {
    if (feature.isNew) {
      await pool.query(
        `INSERT INTO features (id, project_id, feature_type, first_revision_id) VALUES ($1, $2, $3, $4)`,
        [feature.id, projectId, feature.type, revisionId],
      );
    }
    await pool.query(
      `INSERT INTO design_features (revision_id, feature_id, project_id, feature_type, code, layer,
                                    source_kind, source_handle, geom)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ST_GeomFromText($9, 32636))`,
      [
        revisionId,
        feature.id,
        projectId,
        feature.type,
        feature.code ?? null,
        feature.type === 'route' ? 'N_DUC_CBL' : 'sub',
        feature.type === 'route' ? 'curve' : 'insert',
        feature.id.slice(0, 8),
        feature.wkt,
      ],
    );
  }
  await pool.query(`UPDATE design_revisions SET status = 'draft', built_at = now() WHERE id = $1`, [
    revisionId,
  ]);
  // Published one second in the past so a device clock "now" is never before publication.
  await pool.query(
    `UPDATE design_revisions
     SET status = 'published', rev_no = $2, published_at = now() - interval '1 second'
     WHERE id = $1`,
    [revisionId, revNo],
  );
  return revisionId;
}

async function insertItem(
  pool: pg.Pool,
  projectId: string,
  workOrderId: string,
  lineNo: number,
  code: string,
  unit: string,
  quantity: string,
  workType: string,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO work_order_items (project_id, work_order_id, line_no, code, description, unit,
                                   quantity, unit_price, work_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8) RETURNING id`,
    [projectId, workOrderId, lineNo, code, `Test item ${code}`, unit, quantity, workType],
  );
  return rows[0]?.id ?? '';
}

async function insertWorkOrder(pool: pg.Pool, projectId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO work_orders (project_id, number, currency) VALUES ($1, $2, 'EGP') RETURNING id`,
    [projectId, `WO-${randomUUID().slice(0, 8)}`],
  );
  return rows[0]?.id ?? '';
}

async function userId(pool: pg.Pool, email: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [
    email,
  ]);
  return rows[0]?.id ?? '';
}

export async function createExecutionFixture(ctx: TestContext): Promise<ExecutionFixture> {
  const { pool } = ctx;
  const tag = randomUUID().slice(0, 8);
  const projectId = await insertProject(pool, `Execution ${tag}`);
  const otherProjectId = await insertProject(pool, `Execution other ${tag}`);

  const zone = async (name: string, geom: string) =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO zones (project_id, name, geom) VALUES ($1, $2, ${geom}) RETURNING id`,
        [projectId, name],
      )
    ).rows[0]?.id ?? '';
  const zoneA = await zone('Zone A', square(E0 - 10, N0 - 10, 200));
  const zoneB = await zone('Zone B', square(E0 + 900, N0 + 900, 200));

  const routeA = randomUUID();
  const boxA = randomUUID();
  const boxB = randomUUID();
  const revisionId = await publishRevision(
    pool,
    projectId,
    [
      {
        id: routeA,
        type: 'route',
        wkt: `LINESTRING(${E0} ${N0}, ${E0 + 100} ${N0})`,
        isNew: true,
      },
      { id: boxA, type: 'box', wkt: `POINT(${E0 + 50} ${N0 + 5})`, code: '1-1', isNew: true },
      { id: boxB, type: 'box', wkt: `POINT(${E0 + 1000} ${N0 + 1000})`, code: '2-1', isNew: true },
    ],
    1,
  );

  const workOrderId = await insertWorkOrder(pool, projectId);
  const items = {
    civilMetres: await insertItem(pool, projectId, workOrderId, 1, 'C-01', 'م', '100', 'civil'),
    civilPieces: await insertItem(pool, projectId, workOrderId, 2, 'C-02', 'عدد', '10', 'civil'),
    installation: await insertItem(
      pool,
      projectId,
      workOrderId,
      3,
      'I-01',
      'عدد',
      '5',
      'installation',
    ),
  };
  const otherOrder = await insertWorkOrder(pool, otherProjectId);
  const foreignItem = await insertItem(pool, otherProjectId, otherOrder, 1, 'X', 'م', '1', 'civil');

  const member = async (
    key: string,
    role: 'pm' | 'qc' | 'supervisor' | 'contractor',
    zoneId?: string,
  ) => {
    const email = `exec-${key}-${tag}@ftth.local`;
    const password = `Exec#${key}123`;
    await ensureMember(pool, {
      email,
      password,
      role,
      projectId,
      ...(zoneId ? { zoneId } : {}),
    });
    return { email, token: await loginAs(ctx, email, password) };
  };
  const pm = await member('pm', 'pm');
  const qc = await member('qc', 'qc');
  const supA = await member('supa', 'supervisor', zoneA);
  const supA2 = await member('supa2', 'supervisor', zoneA);
  const supB = await member('supb', 'supervisor', zoneB);
  const contractor = await member('con', 'contractor', zoneA);

  return {
    projectId,
    otherProjectId,
    zoneA,
    zoneB,
    revisionId,
    routeA,
    boxA,
    boxB,
    items,
    foreignItem,
    tokens: {
      admin: await loginAs(ctx, ...SEED_LOGINS.admin),
      pm: pm.token,
      qc: qc.token,
      supervisorA: supA.token,
      supervisorA2: supA2.token,
      supervisorB: supB.token,
      contractor: contractor.token,
    },
    userIds: {
      supervisorA: await userId(pool, supA.email),
      supervisorA2: await userId(pool, supA2.email),
      supervisorB: await userId(pool, supB.email),
    },
  };
}

/** WGS 84 of a project-CRS point, computed by PostGIS (the single source of truth). */
export async function toWgs84(pool: pg.Pool, e: number, n: number): Promise<[number, number]> {
  const { rows } = await pool.query<{ lon: number; lat: number }>(
    `SELECT ST_X(p) AS lon, ST_Y(p) AS lat
     FROM ST_Transform(ST_SetSRID(ST_MakePoint($1, $2), 32636), 4326) AS p`,
    [e, n],
  );
  const row = rows[0];
  if (!row) throw new Error('transform failed');
  return [row.lon, row.lat];
}
