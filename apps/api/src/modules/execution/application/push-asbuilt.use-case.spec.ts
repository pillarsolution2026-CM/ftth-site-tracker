import type { OpRejectionCode, RecordAsBuiltEditOp, SyncOp } from '@ftth/shared';
import { describe, expect, it } from 'vitest';
import { Phase2UnavailableCapabilities } from './phase2-capabilities.js';
import type { ExecutionScope, ExecutionTx, NewAsBuiltEdit } from './ports.js';
import { PushSyncUseCase } from './push-sync.use-case.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = new Date('2026-11-01T10:00:00Z');
const REVISION = id(3);
const FEATURE = id(2);

const reshape: RecordAsBuiltEditOp = {
  kind: 'asbuilt_edit.record',
  clientOpId: id(1),
  capturedAt: '2026-11-01T09:59:00Z',
  payload: {
    kind: 'reshape',
    featureId: FEATURE,
    designRevisionId: REVISION,
    baseVersion: 0,
    geometry: {
      type: 'LineString',
      coordinates: [
        [0, 0],
        [10, 0],
      ],
    },
    note: null,
    gps: null,
  },
};
const move: RecordAsBuiltEditOp = {
  ...reshape,
  payload: {
    kind: 'move',
    featureId: FEATURE,
    designRevisionId: REVISION,
    baseVersion: 0,
    geometry: { type: 'Point', coordinates: [1, 2] },
    note: null,
    gps: null,
  },
};
const addRoute: RecordAsBuiltEditOp = {
  ...reshape,
  payload: {
    kind: 'add_route',
    featureId: id(20),
    designRevisionId: REVISION,
    geometry: reshape.payload.kind === 'reshape' ? reshape.payload.geometry : (undefined as never),
    label: null,
    note: null,
    gps: null,
  },
};

interface World {
  published: boolean;
  idTaken: boolean;
  target: { featureType: 'route' | 'box'; origin: 'design' | 'added' } | null;
  featureInRevision: boolean;
  valid: boolean;
  lengthM: number;
  geometryInScope: boolean;
  featureInScope: boolean;
  versions: { geometryVersion: number; labelVersion: number };
  latestId: string;
}

function setup(partial: Partial<World> = {}) {
  const world: World = {
    published: true,
    idTaken: false,
    target: { featureType: 'route', origin: 'design' },
    featureInRevision: true,
    valid: true,
    lengthM: 10,
    geometryInScope: true,
    featureInScope: true,
    versions: { geometryVersion: 0, labelVersion: 0 },
    latestId: REVISION,
    ...partial,
  };
  const calls: string[] = [];
  const inserted: NewAsBuiltEdit[] = [];
  const events: string[] = [];
  const note =
    <T>(name: string, value: T) =>
    async () => {
      calls.push(name);
      return value;
    };
  const tx = {
    lockProject: async () => undefined,
    findOperation: async () => null,
    insertOperation: async () => undefined,
    appendEvent: async (event: { type: string }) => {
      events.push(event.type);
    },
    publishedRevision: async () => {
      calls.push('publishedRevision');
      return world.published ? { publishedAt: new Date(0), crsEpsg: 32636 } : null;
    },
    featureIdTaken: note('featureIdTaken', world.idTaken),
    asBuiltTarget: note('asBuiltTarget', world.target),
    featureInRevision: note('featureInRevision', world.featureInRevision),
    geometryFacts: note('geometryFacts', { valid: world.valid, lengthM: world.lengthM }),
    latestPublishedRevision: note('latestPublishedRevision', {
      id: world.latestId,
      revNo: 1,
      publishedAt: new Date(0),
      hasTiles: false,
    }),
    featureInScope: note('featureInScope', world.featureInScope),
    addedFeatureInScope: note('addedFeatureInScope', true),
    geometryInScope: note('geometryInScope', world.geometryInScope),
    approvedVersions: note('approvedVersions', world.versions),
    insertAsBuiltEdit: async (edit: NewAsBuiltEdit) => {
      calls.push('insertAsBuiltEdit');
      inserted.push(edit);
      return { lengthM: '10' };
    },
  } as unknown as ExecutionTx;
  const useCase = new PushSyncUseCase(
    { run: (work) => work(tx) },
    new Phase2UnavailableCapabilities(),
    { now: () => NOW },
    { next: () => id(99) },
  );
  const push = async (
    op: SyncOp,
    scopes: { asBuiltScope?: ExecutionScope | null; scope?: ExecutionScope | null } = {},
  ) => {
    const [result] = await useCase.execute({
      projectId: id(10),
      userId: id(11),
      deviceId: id(12),
      scope: scopes.scope === undefined ? { kind: 'project' } : scopes.scope,
      asBuiltScope: scopes.asBuiltScope === undefined ? { kind: 'project' } : scopes.asBuiltScope,
      ops: [op],
    });
    return result;
  };
  return { push, calls, inserted, events };
}

const zones: ExecutionScope = { kind: 'zones', zoneIds: [id(50)] };

function rejected(result: unknown): OpRejectionCode | null {
  const r = result as { outcome: string; code?: OpRejectionCode };
  return r.outcome === 'rejected' ? (r.code ?? null) : null;
}

describe('As-Built edit check order', () => {
  it('refuses without the asbuilt:write permission before touching anything', async () => {
    const { push, calls } = setup();
    expect(rejected(await push(reshape, { asBuiltScope: null }))).toBe('FEATURE_OUT_OF_SCOPE');
    expect(calls).toEqual([]);
  });

  it('refuses an execution update without execution:write (fail closed)', async () => {
    const { push } = setup();
    const update = {
      kind: 'execution_update.record',
      clientOpId: id(1),
      capturedAt: '2026-11-01T09:59:00Z',
      payload: {
        featureId: FEATURE,
        designRevisionId: REVISION,
        workType: 'civil',
        lines: [{ workOrderItemId: id(4), quantity: '1', role: 'work' }],
        label: null,
        note: null,
        gps: null,
        photos: [],
        acknowledgedWarnings: [],
      },
    } as SyncOp;
    expect(rejected(await push(update, { scope: null }))).toBe('FEATURE_OUT_OF_SCOPE');
  });

  it('REVISION_NOT_PUBLISHED comes before anything about the feature', async () => {
    const { push, calls } = setup({ published: false, idTaken: true });
    expect(rejected(await push(addRoute))).toBe('REVISION_NOT_PUBLISHED');
    expect(calls).toEqual(['publishedRevision']);
  });

  it('FEATURE_ID_REUSED for an add whose id exists, before the geometry is looked at', async () => {
    const { push, calls } = setup({ idTaken: true, valid: false });
    expect(rejected(await push(addRoute))).toBe('FEATURE_ID_REUSED');
    expect(calls).not.toContain('geometryFacts');
  });

  it('FEATURE_NOT_FOUND for an unknown feature', async () => {
    const { push } = setup({ target: null });
    expect(rejected(await push(reshape))).toBe('FEATURE_NOT_FOUND');
  });

  it('REVISION_NOT_PUBLISHED when the design feature is not in the named revision', async () => {
    const { push } = setup({ featureInRevision: false });
    expect(rejected(await push(reshape))).toBe('REVISION_NOT_PUBLISHED');
  });

  it('GEOMETRY_KIND_MISMATCH (move on a route, reshape on a point) before validity', async () => {
    const onRoute = setup({ target: { featureType: 'route', origin: 'design' }, valid: false });
    expect(rejected(await onRoute.push(move))).toBe('GEOMETRY_KIND_MISMATCH');
    expect(onRoute.calls).not.toContain('geometryFacts');
    const onPoint = setup({ target: { featureType: 'box', origin: 'design' } });
    expect(rejected(await onPoint.push(reshape))).toBe('GEOMETRY_KIND_MISMATCH');
  });

  it('GEOMETRY_INVALID for an invalid shape or a zero-length route, before the zone check', async () => {
    const invalid = setup({ valid: false, geometryInScope: false, featureInScope: false });
    expect(rejected(await invalid.push(reshape, { asBuiltScope: zones }))).toBe('GEOMETRY_INVALID');
    expect(invalid.calls).not.toContain('featureInScope');
    const zero = setup({ lengthM: 0 });
    expect(rejected(await zero.push(reshape))).toBe('GEOMETRY_INVALID');
  });

  it('FEATURE_OUT_OF_SCOPE when the design feature or the proposed shape is outside the zones', async () => {
    const featureOut = setup({ featureInScope: false });
    expect(rejected(await featureOut.push(reshape, { asBuiltScope: zones }))).toBe(
      'FEATURE_OUT_OF_SCOPE',
    );
    const shapeOut = setup({ geometryInScope: false });
    expect(rejected(await shapeOut.push(reshape, { asBuiltScope: zones }))).toBe(
      'FEATURE_OUT_OF_SCOPE',
    );
    expect(shapeOut.inserted).toHaveLength(0);
  });

  it('a project-wide scope never asks for zones', async () => {
    const { push, calls } = setup({ geometryInScope: false, featureInScope: false });
    expect((await push(reshape))?.outcome).toBe('applied');
    expect(calls).not.toContain('geometryInScope');
    expect(calls).not.toContain('featureInScope');
  });
});

describe('As-Built edit flags and writes', () => {
  it('records the edit with its event and the design feature type', async () => {
    const { push, inserted, events } = setup();
    const result = await push(reshape);
    expect(result).toEqual({ clientOpId: id(1), outcome: 'applied', updateId: id(99) });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      featureType: 'route',
      baseVersion: 0,
      srid: 32636,
      flags: [],
      label: null,
    });
    expect(events).toEqual(['asbuilt_edit.recorded']);
  });

  it('flags BASE_OUTDATED, REVISION_OUTDATED and FEATURE_REMOVED without rejecting', async () => {
    const { push, inserted } = setup({
      versions: { geometryVersion: 2, labelVersion: 0 },
      latestId: id(77),
      featureInRevision: true,
    });
    // featureInRevision answers true for both the named and the latest revision here.
    expect((await push(reshape))?.outcome).toBe('applied');
    expect(inserted[0]?.flags).toEqual(['BASE_OUTDATED', 'REVISION_OUTDATED']);
  });

  it('flags CLOCK_AHEAD beyond the tolerance', async () => {
    const { push, inserted } = setup();
    await push({ ...reshape, capturedAt: '2026-11-01T10:06:00Z' });
    expect(inserted[0]?.flags).toEqual(['CLOCK_AHEAD']);
  });

  it('an add has no base and never BASE_OUTDATED; type route', async () => {
    const { push, inserted } = setup({ versions: { geometryVersion: 5, labelVersion: 5 } });
    expect((await push(addRoute))?.outcome).toBe('applied');
    expect(inserted[0]).toMatchObject({ featureType: 'route', baseVersion: null, flags: [] });
  });
});
