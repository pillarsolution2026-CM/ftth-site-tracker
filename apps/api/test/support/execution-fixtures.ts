import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  createApprovedContract,
  createProjectIn,
  createWorkOrderFrom,
} from './contract-fixtures.js';
import { insertDrawing } from './drawing-fixtures.js';
import { ensureMember, loginAs, SEED_LOGINS } from './helpers.js';
import type { TestContext } from './test-app.js';

/**
 * TEST DATA ONLY. A fresh project with what Phase 3 needs and Phase 2 has not built yet: two
 * sites of the work order (ADR-054: supervisors work by site), each with a published General
 * drawing (the CAD worker's side simulated with SQL, as in the design-revision tests), and a work
 * order. Never used outside the integration tests.
 */

/** Somewhere in Qalyub, UTM 36N (EPSG:32636), metres. */
export const E0 = 330_000;
export const N0 = 3_340_000;

export interface ExecutionFixture {
  projectId: string;
  otherProjectId: string;
  workOrderId: string;
  /** Sites of the work order: A and B (supervisors A and A2 hold A, supervisor B holds B). */
  siteA: string;
  siteB: string;
  /** The General drawings of the sites. */
  drawingA: string;
  drawingB: string;
  /** Published revision of site A's General (the project's default General, published last). */
  revisionId: string;
  /** Published revision of site B's General. */
  revisionB: string;
  /** Route from (E0, N0) to (E0 + 100, N0), drawn in site A's revision. */
  routeA: string;
  /** Box at (E0 + 50, N0 + 5), drawn in site A's revision. */
  boxA: string;
  /** Box at (E0 + 1000, N0 + 1000), drawn in site B's revision only. */
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

/** A revision built and published, with the given features (WKT in EPSG:32636). */
export async function publishRevision(
  pool: pg.Pool,
  projectId: string,
  features: { id: string; type: string; wkt: string; code?: string; isNew: boolean }[],
  revNo: number,
  /** ADR-040: the General is what the mobile bundle and As-Built read; default as before. */
  drawingKind: 'general' | 'secondary' = 'general',
  /**
   * The site of the drawing: a string reuses that site's file of the kind (or makes its drawing);
   * null makes an unassigned drawing; omitted keeps the old behaviour (the project's first file).
   */
  options: {
    siteId?: string | null;
    /** How long ago it was published (a published revision is immutable: set it here). */
    publishedAgoSeconds?: number;
    /** A new drawing of the kind with this ordinal even when the site has one (ADR-049). */
    newDrawingOrdinal?: number;
  } = {},
): Promise<string> {
  // A later revision of the same kind is a newer revision of the same drawing (ADR-049 part B):
  // feature identity, REVISION_OUTDATED and FEATURE_REMOVED are per drawing.
  const existing = await pool.query<{ id: string }>(
    `SELECT f.id FROM cad_files f
     JOIN site_drawings d ON d.id = f.drawing_id
     WHERE f.project_id = $1 AND f.drawing_kind = $2 AND f.superseded_at IS NULL
       AND ($3::boolean = false OR d.site_id IS NOT DISTINCT FROM $4::uuid)
     ORDER BY f.created_at LIMIT 1`,
    [projectId, drawingKind, options.siteId !== undefined, options.siteId ?? null],
  );
  let fileId = options.newDrawingOrdinal ? undefined : existing.rows[0]?.id;
  if (!fileId) {
    fileId = randomUUID();
    const drawingId = await insertDrawing(
      (text, values) => pool.query(text, values),
      projectId,
      drawingKind,
      { siteId: options.siteId ?? null, ordinal: options.newDrawingOrdinal },
    );
    await pool.query(
      `INSERT INTO cad_files (id, project_id, original_name, format, size_bytes, sha256, storage_key,
                              status, current_job_id, processed_at, drawing_kind, drawing_id)
       VALUES ($1, $2, 'plan.dxf', 'dxf', 100, repeat('a', 64), $3, 'processed', $4, now(), $5, $6)`,
      [
        fileId,
        projectId,
        `projects/${projectId}/cad/${fileId}/original.dxf`,
        randomUUID(),
        drawingKind,
        drawingId,
      ],
    );
  }
  const revisionId = randomUUID();
  await pool.query(
    `INSERT INTO design_revisions (id, project_id, cad_file_id, status, current_job_id, rules,
                                   mapping_version, crs_epsg, drawing_unit, metres_per_unit,
                                   drawing_kind)
     VALUES ($1, $2, $3, 'building', $4, '[]', 1, 32636, 'm', 1, $5)`,
    [revisionId, projectId, fileId, randomUUID(), drawingKind],
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
     SET status = 'published', rev_no = $2, published_at = now() - make_interval(secs => $3)
     WHERE id = $1`,
    [revisionId, revNo, options.publishedAgoSeconds ?? 1],
  );
  return revisionId;
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
  // Work orders come from an approved contract (ADR-028); both projects share this one.
  const contract = await createApprovedContract(pool, [
    { code: 'C-01', unit: 'م', quantity: '100', unitPrice: '0', workType: 'civil' },
    { code: 'C-02', unit: 'عدد', quantity: '10', unitPrice: '0', workType: 'civil' },
    { code: 'I-01', unit: 'عدد', quantity: '5', unitPrice: '0', workType: 'installation' },
    { code: 'X', unit: 'م', quantity: '1', unitPrice: '0', workType: 'civil' },
  ]);
  const projectId = await createProjectIn(pool, contract.contractId, `Execution ${tag}`);
  const otherProjectId = await createProjectIn(pool, contract.contractId, `Execution other ${tag}`);

  // The work order, its two sites and one General drawing per site (ADR-049, ADR-054).
  const own = await createWorkOrderFrom(pool, projectId, contract, {
    'C-01': '100',
    'C-02': '10',
    'I-01': '5',
  });
  const items = {
    civilMetres: own.itemIdsByCode['C-01'] ?? '',
    civilPieces: own.itemIdsByCode['C-02'] ?? '',
    installation: own.itemIdsByCode['I-01'] ?? '',
  };
  const site = async (name: string, position: number) => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO work_order_sites (id, project_id, work_order_id, name, name_key, position)
       VALUES ($1, $2, $3, $4, $4, $5)`,
      [id, projectId, own.workOrderId, name, position],
    );
    return id;
  };
  const siteA = await site(`Site A ${tag}`, 1);
  const siteB = await site(`Site B ${tag}`, 2);

  const routeA = randomUUID();
  const boxA = randomUUID();
  const boxB = randomUUID();
  // Site B's General first, then site A's, so that A is "the General published last" (the
  // project's default drawing for the old lookups). A published revision is immutable, so the
  // order of publication sets this, not an UPDATE.
  const revisionB = await publishRevision(
    pool,
    projectId,
    [{ id: boxB, type: 'box', wkt: `POINT(${E0 + 1000} ${N0 + 1000})`, code: '2-1', isNew: true }],
    1,
    'general',
    { siteId: siteB },
  );
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
    ],
    1,
    'general',
    { siteId: siteA },
  );
  const drawingOf = async (revision: string) =>
    (
      await pool.query<{ drawing_id: string }>(
        'SELECT drawing_id FROM design_revisions WHERE id = $1',
        [revision],
      )
    ).rows[0]?.drawing_id ?? '';
  const drawingA = await drawingOf(revisionId);
  const drawingB = await drawingOf(revisionB);

  const other = await createWorkOrderFrom(pool, otherProjectId, contract, { X: '1' });
  const foreignItem = other.itemIdsByCode.X ?? '';

  const member = async (
    key: string,
    role: 'pm' | 'qc' | 'supervisor' | 'contractor',
    siteIds: string[] = [],
  ) => {
    const email = `exec-${key}-${tag}@ftth.local`;
    const password = `Exec#${key}123`;
    await ensureMember(pool, {
      email,
      password,
      role,
      projectId,
      siteIds,
    });
    return { email, token: await loginAs(ctx, email, password) };
  };
  const pm = await member('pm', 'pm');
  const qc = await member('qc', 'qc');
  const supA = await member('supa', 'supervisor', [siteA]);
  const supA2 = await member('supa2', 'supervisor', [siteA]);
  const supB = await member('supb', 'supervisor', [siteB]);
  const contractor = await member('con', 'contractor');

  return {
    projectId,
    otherProjectId,
    workOrderId: own.workOrderId,
    siteA,
    siteB,
    drawingA,
    drawingB,
    revisionId,
    revisionB,
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
