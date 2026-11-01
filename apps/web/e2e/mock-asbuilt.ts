/**
 * As-Built review part of the Playwright mock API (`docs/phase-4-contracts.md`, "Web review" and
 * "As-Built DXF export"). Started with plain `node` (type stripping), so it only uses erasable
 * TypeScript. Every JSON answer is parsed with the shared schemas before it is sent.
 *
 * Simplifications (not the real implementation): a fixed set of edits; the mock user (a PM) holds
 * every As-Built permission; the DXF export is simulated by time (queued -> processing -> done)
 * and the file is a tiny stand-in, not a real drawing.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AsBuiltEditDetailSchema,
  AsBuiltEditListResponseSchema,
  AsBuiltEditSchema,
  AsBuiltExportListResponseSchema,
  AsBuiltExportSchema,
  RejectAsBuiltEditRequestSchema,
  type AsBuiltEdit,
  type AsBuiltEditDetail,
  type AsBuiltExport,
} from '@ftth/shared';
import type { Helpers } from './mock-design.ts';

const REVISION_ID = '4f8fad5b-d9cb-469f-a165-70867728950e';
const OTHER_USER = '5f8fad5b-d9cb-469f-a165-70867728950e';
const DEVICE = '7f8fad5b-d9cb-469f-a165-70867728950e';
const CRS = 32636;

export const ASBUILT_IDS = {
  reshape: '21111111-1111-4111-8111-111111111111',
  moveBox: '22222222-2222-4222-8222-222222222222',
  stale: '23333333-3333-4333-8333-333333333333',
  own: '24444444-4444-4444-8444-444444444444',
} as const;

interface Seed {
  edit: AsBuiltEdit;
  detail: Omit<AsBuiltEditDetail, 'edit'>;
}

function baseEdit(overrides: Partial<AsBuiltEdit> & Pick<AsBuiltEdit, 'id'>): AsBuiltEdit {
  return {
    clientOpId: randomUUID(),
    featureId: randomUUID(),
    kind: 'reshape',
    featureType: 'route',
    designRevisionId: REVISION_ID,
    baseVersion: 0,
    geometry: null,
    label: null,
    lengthM: null,
    note: null,
    userId: OTHER_USER,
    userName: 'حسن علي',
    deviceId: DEVICE,
    capturedAt: '2026-05-02T08:00:00.000+00:00',
    receivedAt: '2026-05-02T08:05:00.000+00:00',
    flags: [],
    status: 'pending',
    reviewReason: null,
    reviewedBy: null,
    reviewedAt: null,
    approvedVersion: null,
    ...overrides,
  };
}

const designRoute = {
  revisionId: REVISION_ID,
  code: 'R-014',
  layer: 'ROUTE-MAIN',
  geometry: {
    type: 'LineString' as const,
    coordinates: [
      [500000, 3300000],
      [500120, 3300000],
    ] as [number, number][],
  },
  lengthM: '120.000',
};

function seeds(ownerId: string): Seed[] {
  return [
    {
      edit: baseEdit({
        id: ASBUILT_IDS.reshape,
        geometry: {
          type: 'LineString',
          coordinates: [
            [500000, 3300000],
            [500060, 3300012],
            [500120, 3300000],
          ],
        },
        lengthM: '122.066',
        note: 'المسار يلتف حول العمود الجديد',
        receivedAt: '2026-05-02T08:05:00.000+00:00',
      }),
      detail: { crsEpsg: CRS, design: designRoute, current: null, approvable: true },
    },
    {
      edit: baseEdit({
        id: ASBUILT_IDS.moveBox,
        kind: 'move',
        featureType: 'box',
        geometry: { type: 'Point', coordinates: [500044, 3300009] },
        flags: ['REVISION_OUTDATED'],
        receivedAt: '2026-05-02T07:50:00.000+00:00',
      }),
      detail: {
        crsEpsg: CRS,
        design: {
          revisionId: REVISION_ID,
          code: 'B-007',
          layer: 'BOX',
          geometry: { type: 'Point', coordinates: [500040, 3300004] },
          lengthM: null,
        },
        current: null,
        approvable: true,
      },
    },
    {
      edit: baseEdit({
        id: ASBUILT_IDS.stale,
        geometry: {
          type: 'LineString',
          coordinates: [
            [500000, 3300000],
            [500120, 3300020],
          ],
        },
        lengthM: '121.655',
        baseVersion: 0,
        flags: ['BASE_OUTDATED', 'CLOCK_AHEAD'],
        receivedAt: '2026-05-02T07:40:00.000+00:00',
      }),
      detail: {
        crsEpsg: CRS,
        design: designRoute,
        current: {
          featureId: '31111111-1111-4111-8111-111111111111',
          featureType: 'route',
          added: false,
          geometry: {
            type: 'LineString',
            coordinates: [
              [500000, 3300000],
              [500120, 3300005],
            ],
          },
          lengthM: '120.104',
          label: null,
          geometryVersion: 1,
          labelVersion: 0,
        },
        approvable: false,
      },
    },
    {
      edit: baseEdit({
        id: ASBUILT_IDS.own,
        kind: 'add_symbol',
        featureType: 'hhi',
        baseVersion: null,
        geometry: { type: 'Point', coordinates: [500090, 3300030] },
        label: 'HH-NEW',
        userId: ownerId,
        userName: 'منى أحمد',
        receivedAt: '2026-05-02T07:30:00.000+00:00',
      }),
      detail: { crsEpsg: CRS, design: null, current: null, approvable: true },
    },
  ];
}

const EXPORT_QUEUED_MS = 1500;
const EXPORT_PROCESSING_MS = 3500;

interface StoredExport {
  id: string;
  requestedAt: number;
}

export interface AsBuiltMock {
  handle: (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    method: string,
    path: (string | undefined)[],
  ) => Promise<void>;
}

/** `ownerId` is the mock user: an edit recorded by them cannot be reviewed by them. */
export function createAsBuiltMock(ownerId: string, helpers: Helpers): AsBuiltMock {
  const { send, sendError, readJson } = helpers;
  const store = new Map<string, Seed>(seeds(ownerId).map((seed) => [seed.edit.id, seed]));
  const exportsStore: StoredExport[] = [];

  const exportView = (item: StoredExport): AsBuiltExport => {
    const age = Date.now() - item.requestedAt;
    const status =
      age < EXPORT_QUEUED_MS ? 'queued' : age < EXPORT_PROCESSING_MS ? 'processing' : 'done';
    return AsBuiltExportSchema.parse({
      id: item.id,
      revisionId: REVISION_ID,
      status,
      requestedBy: ownerId,
      requestedAt: new Date(item.requestedAt).toISOString(),
      finishedAt:
        status === 'done' ? new Date(item.requestedAt + EXPORT_PROCESSING_MS).toISOString() : null,
      stats: status === 'done' ? { designFeatures: 24, editedFeatures: 2, addedFeatures: 1 } : null,
      sizeBytes: status === 'done' ? 4096 : null,
      error: null,
    });
  };

  function review(
    res: ServerResponse,
    seed: Seed,
    outcome: { status: 'approved' | 'rejected'; reason: string | null },
  ): void {
    if (seed.edit.status !== 'pending') {
      return sendError(res, 409, 'CONFLICT', { reason: 'NOT_PENDING' });
    }
    if (seed.edit.userId === ownerId) {
      return sendError(res, 403, 'FORBIDDEN', { reason: 'SELF_REVIEW' });
    }
    if (outcome.status === 'approved' && !seed.detail.approvable) {
      return sendError(res, 409, 'CONFLICT', { reason: 'STALE_BASE' });
    }
    seed.edit = {
      ...seed.edit,
      status: outcome.status,
      reviewReason: outcome.reason,
      reviewedBy: ownerId,
      reviewedAt: new Date().toISOString(),
      approvedVersion: outcome.status === 'approved' ? 1 : null,
    };
    seed.detail = { ...seed.detail, approvable: false };
    send(res, 200, AsBuiltEditSchema.parse(seed.edit));
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    method: string,
    [resource, id, action]: (string | undefined)[],
  ): Promise<void> {
    if (resource === 'edits' && id === undefined && method === 'GET') {
      const status = url.searchParams.get('status');
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const all = [...store.values()]
        .map((seed) => seed.edit)
        .filter((edit) => status === null || edit.status === status)
        .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
      return send(
        res,
        200,
        AsBuiltEditListResponseSchema.parse({
          items: all.slice(offset, offset + limit),
          total: all.length,
        }),
      );
    }
    if (resource === 'edits' && id !== undefined) {
      const seed = store.get(id);
      if (!seed) return sendError(res, 404, 'NOT_FOUND');
      if (action === undefined && method === 'GET') {
        return send(res, 200, AsBuiltEditDetailSchema.parse({ edit: seed.edit, ...seed.detail }));
      }
      if (action === 'approve' && method === 'POST') {
        return review(res, seed, { status: 'approved', reason: null });
      }
      if (action === 'reject' && method === 'POST') {
        const parsed = RejectAsBuiltEditRequestSchema.safeParse(await readJson(req));
        if (!parsed.success) return sendError(res, 422, 'VALIDATION_FAILED');
        return review(res, seed, { status: 'rejected', reason: parsed.data.reason });
      }
    }
    if (resource === 'exports' && id === undefined) {
      if (method === 'POST') {
        const item = { id: randomUUID(), requestedAt: Date.now() };
        exportsStore.unshift(item);
        return send(res, 202, exportView(item));
      }
      if (method === 'GET') {
        return send(
          res,
          200,
          AsBuiltExportListResponseSchema.parse({ items: exportsStore.map(exportView) }),
        );
      }
    }
    if (resource === 'exports' && id !== undefined && method === 'GET') {
      const item = exportsStore.find((entry) => entry.id === id);
      if (!item) return sendError(res, 404, 'NOT_FOUND');
      if (action === undefined) return send(res, 200, exportView(item));
      if (action === 'file') {
        if (exportView(item).status !== 'done') {
          return sendError(res, 409, 'CONFLICT', { reason: 'NOT_DONE' });
        }
        res
          .writeHead(200, {
            'content-type': 'application/dxf',
            'content-disposition': `attachment; filename="asbuilt-${item.id}.dxf"`,
            'x-content-type-options': 'nosniff',
          })
          .end('0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n6\n0\nENDSEC\n0\nEOF\n');
        return;
      }
    }
    return sendError(res, 404, 'NOT_FOUND');
  }

  return { handle };
}
