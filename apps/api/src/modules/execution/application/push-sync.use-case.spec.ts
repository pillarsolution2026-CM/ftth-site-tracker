import type { RecordUpdateOp } from '@ftth/shared';
import { describe, expect, it } from 'vitest';
import type {
  ContractorLineFacts,
  ExecutionScope,
  ExecutionTx,
  ExecutionUnitOfWork,
  NewUpdate,
} from './ports.js';
import { Phase2UnavailableCapabilities } from './phase2-capabilities.js';
import { PushSyncUseCase } from './push-sync.use-case.js';

/** The As-Built side is not used by these Phase 3 races (see push-asbuilt.use-case.spec.ts). */
const asBuiltStubs: Pick<
  ExecutionTx,
  | 'publishedRevision'
  | 'featureIdTaken'
  | 'asBuiltTarget'
  | 'geometryFacts'
  | 'revisionInScope'
  | 'geometryOutsideDrawing'
  | 'addedFeatureInScope'
  | 'approvedVersions'
  | 'insertAsBuiltEdit'
  | 'proposalTarget'
  | 'insertGpsProposal'
> = {
  proposalTarget: async () => null,
  insertGpsProposal: async () => undefined,
  publishedRevision: async () => null,
  featureIdTaken: async () => false,
  asBuiltTarget: async () => null,
  geometryFacts: async () => ({ valid: true, lengthM: 1 }),
  revisionInScope: async () => true,
  geometryOutsideDrawing: async () => false,
  addedFeatureInScope: async () => true,
  approvedVersions: async () => ({ geometryVersion: 0, labelVersion: 0 }),
  insertAsBuiltEdit: async () => ({ lengthM: null }),
};

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const op: RecordUpdateOp = {
  kind: 'execution_update.record',
  clientOpId: id(1),
  capturedAt: '2026-10-30T10:00:00Z',
  payload: {
    featureId: id(2),
    drawingId: null,
    designRevisionId: id(3),
    workType: 'civil',
    lines: [
      {
        workOrderItemId: id(4),
        quantity: '1',
        role: 'work',
        performer: { kind: 'self' },
        dimensions: null,
      },
    ],
    label: null,
    note: null,
    gps: null,
    photos: [
      {
        photoId: id(5),
        requirementKey: 'general',
        sha256: 'a'.repeat(64),
        sizeBytes: 10,
        contentType: 'image/jpeg',
        takenAt: '2026-10-30T10:00:00Z',
        gps: null,
      },
    ],
    acknowledgedWarnings: [],
    workDate: null,
  },
};

/** A transaction where every check passes and the insert hits `constraint`. */
function uowFailingOn(
  constraint: string,
  code = '23505',
  message = 'duplicate key',
): ExecutionUnitOfWork {
  const pgError = Object.assign(new Error(message), { code, constraint });
  const tx: ExecutionTx = {
    lockProject: async () => undefined,
    findOperation: async () => null,
    insertOperation: async () => undefined,
    featureExists: async () => true,
    featureInPublishedRevision: async () => ({
      featureType: 'box',
      revisionPublishedAt: new Date(0),
    }),
    featureInScope: async () => true,
    latestPublishedRevision: async () => ({
      id: id(3),
      revNo: 1,
      publishedAt: new Date(0),
      hasTiles: false,
    }),
    featureInRevision: async () => true,
    findItems: async () => [{ id: id(4), workType: 'civil', unit: 'م', group: null }],
    lockContractorLines: async () => [],
    wouldOverrun: async () => false,
    gpsDistanceM: async () => 0,
    anyPhotoExists: async () => false,
    planningDrawing: async () => null,
    publishedRevisionOfDrawing: async () => null,
    insertUpdate: async () => {
      throw new Error('Failed query', { cause: pgError });
    },
    appendEvent: async () => undefined,
    ...asBuiltStubs,
  };
  return { run: (work) => work(tx) };
}

describe('PushSyncUseCase races', () => {
  it('answers PHOTO_ID_REUSED when the same photo id lands in another project at the same time', async () => {
    const useCase = new PushSyncUseCase(
      uowFailingOn('execution_photos_pkey'),
      new Phase2UnavailableCapabilities(),
      { now: () => new Date() },
      { next: () => id(9) },
    );
    const results = await useCase.execute({
      projectId: id(10),
      userId: id(11),
      deviceId: id(12),
      scope: { kind: 'project' },
      ops: [op],
    });
    expect(results).toEqual([
      { clientOpId: op.clientOpId, outcome: 'rejected', code: 'PHOTO_ID_REUSED' },
    ]);
  });

  it.each([
    [
      '',
      '23514',
      'contractor quantity exceeded (contractor line x)',
      'CONTRACTOR_QUANTITY_EXCEEDED',
    ],
    [
      '',
      '23514',
      'the contractor line belongs to another work-order line',
      'CONTRACTOR_LINE_NOT_FOUND',
    ],
    ['execution_update_lines_contractor_line_fkey', '23503', 'fk', 'CONTRACTOR_LINE_NOT_FOUND'],
  ] as const)(
    'turns the contractor backstop (%s %s) into a rejection of the op, not a failed batch',
    async (constraint, code, message, expected) => {
      const useCase = new PushSyncUseCase(
        uowFailingOn(constraint, code, message),
        new Phase2UnavailableCapabilities(),
        { now: () => new Date() },
        { next: () => id(9) },
      );
      const results = await useCase.execute({
        projectId: id(10),
        userId: id(11),
        deviceId: id(12),
        scope: { kind: 'project' },
        ops: [op],
      });
      expect(results).toEqual([{ clientOpId: op.clientOpId, outcome: 'rejected', code: expected }]);
    },
  );

  it('rethrows unrelated database errors', async () => {
    const useCase = new PushSyncUseCase(
      uowFailingOn('something_else'),
      new Phase2UnavailableCapabilities(),
      { now: () => new Date() },
      { next: () => id(9) },
    );
    await expect(
      useCase.execute({
        projectId: id(10),
        userId: id(11),
        deviceId: id(12),
        scope: { kind: 'project' },
        ops: [op],
      }),
    ).rejects.toThrow('Failed query');
  });
});

describe('PushSyncUseCase contractor lines (ADR-052)', () => {
  const ITEM = id(4);
  const OTHER_ITEM = id(40);
  const CL_A = id(51);
  const CL_B = id(52);
  const CL_OTHER_ITEM = id(53);

  const contractorLines = (): ContractorLineFacts[] => [
    {
      id: CL_A,
      workOrderItemId: ITEM,
      quantity: '50',
      recordedQuantity: '10',
      registeredOn: '2026-10-01',
    },
    {
      id: CL_B,
      workOrderItemId: ITEM,
      quantity: '100',
      recordedQuantity: '0',
      registeredOn: '2026-10-01',
    },
    {
      id: CL_OTHER_ITEM,
      workOrderItemId: OTHER_ITEM,
      quantity: '100',
      recordedQuantity: '0',
      registeredOn: '2026-10-01',
    },
  ];

  function setup(lines = contractorLines()) {
    const inserted: NewUpdate[] = [];
    const events: unknown[] = [];
    const tx = {
      lockProject: async () => undefined,
      findOperation: async () => null,
      insertOperation: async () => undefined,
      featureExists: async () => true,
      featureInPublishedRevision: async () => ({
        featureType: 'box' as const,
        revisionPublishedAt: new Date(0),
      }),
      featureInScope: async () => true,
      latestPublishedRevision: async () => ({
        id: id(3),
        revNo: 1,
        publishedAt: new Date(0),
        hasTiles: false,
      }),
      featureInRevision: async () => true,
      findItems: async () => [{ id: ITEM, workType: 'civil' as const, unit: 'م', group: null }],
      // Only the known contractor lines of this project are found, like the real query.
      lockContractorLines: async (_project: string, ids: readonly string[]) =>
        lines.filter((line) => ids.includes(line.id)),
      wouldOverrun: async () => false,
      gpsDistanceM: async () => 0,
      anyPhotoExists: async () => false,
      planningDrawing: async () => null,
      publishedRevisionOfDrawing: async () => null,
      insertUpdate: async (update: NewUpdate) => {
        inserted.push(update);
      },
      appendEvent: async (event: unknown) => {
        events.push(event);
      },
      ...asBuiltStubs,
    } as ExecutionTx;
    const useCase = new PushSyncUseCase(
      { run: (work) => work(tx) },
      new Phase2UnavailableCapabilities(),
      { now: () => new Date() },
      { next: () => id(9) },
    );
    const push = (workLines: RecordUpdateOp['payload']['lines']) =>
      useCase.execute({
        projectId: id(10),
        userId: id(11),
        deviceId: id(12),
        scope: { kind: 'project' },
        ops: [{ ...op, payload: { ...op.payload, lines: workLines } }],
      });
    return { push, inserted, events };
  }

  const work = (
    quantity: string,
    performer: RecordUpdateOp['payload']['lines'][number]['performer'],
    workOrderItemId = ITEM,
  ) => ({ workOrderItemId, quantity, role: 'work' as const, performer, dimensions: null });

  it('accepts a work line of the own crew, with no cap', async () => {
    const { push, inserted } = setup();
    const [result] = await push([work('100000', { kind: 'self' })]);
    expect(result?.outcome).toBe('applied');
    expect(inserted[0]?.lines[0]?.performer).toEqual({ kind: 'self' });
  });

  it('accepts a contractor line up to what is left of its quantity', async () => {
    const { push, inserted, events } = setup();
    const [result] = await push([work('40', { kind: 'contractor', contractorLineId: CL_A })]);
    expect(result?.outcome).toBe('applied');
    expect(inserted[0]?.lines[0]?.performer).toEqual({
      kind: 'contractor',
      contractorLineId: CL_A,
    });
    // The performer travels in the event payload with the lines.
    expect(JSON.stringify(events)).toContain(CL_A);
  });

  it('rejects an unknown contractor line', async () => {
    const { push, inserted } = setup();
    const [result] = await push([work('1', { kind: 'contractor', contractorLineId: id(99) })]);
    expect(result).toMatchObject({ outcome: 'rejected', code: 'CONTRACTOR_LINE_NOT_FOUND' });
    expect(inserted).toHaveLength(0);
  });

  it('rejects a contractor line of another work-order line', async () => {
    const { push } = setup();
    const [result] = await push([
      work('1', { kind: 'contractor', contractorLineId: CL_OTHER_ITEM }),
    ]);
    expect(result).toMatchObject({ outcome: 'rejected', code: 'CONTRACTOR_LINE_NOT_FOUND' });
  });

  it('rejects work above the quantity left on the contractor line', async () => {
    const { push, inserted } = setup();
    const [result] = await push([work('40.0001', { kind: 'contractor', contractorLineId: CL_A })]);
    expect(result).toMatchObject({ outcome: 'rejected', code: 'CONTRACTOR_QUANTITY_EXCEEDED' });
    expect(inserted).toHaveLength(0);
  });

  it('lets rejected work free its quantity (the server counts pending and approved only)', async () => {
    // recordedQuantity is what the repository computes without rejected updates: 0 after a rejection.
    const { push } = setup([
      {
        id: CL_A,
        workOrderItemId: ITEM,
        quantity: '50',
        recordedQuantity: '0',
        registeredOn: '2026-10-01',
      },
    ]);
    const [result] = await push([work('50', { kind: 'contractor', contractorLineId: CL_A })]);
    expect(result?.outcome).toBe('applied');
  });

  it('splits one work-order line between two contractors and the own crew', async () => {
    const { push, inserted } = setup();
    const [result] = await push([
      work('20', { kind: 'contractor', contractorLineId: CL_A }),
      work('30', { kind: 'contractor', contractorLineId: CL_B }),
      work('50', { kind: 'self' }),
    ]);
    expect(result?.outcome).toBe('applied');
    expect(inserted[0]?.lines.map((line) => line.performer?.kind)).toEqual([
      'contractor',
      'contractor',
      'self',
    ]);
  });

  it('sums the parts of one contractor line inside the op', async () => {
    const { push } = setup();
    const lines = [
      work('25', { kind: 'contractor', contractorLineId: CL_A }),
      { ...work('25', { kind: 'contractor', contractorLineId: CL_A }), role: 'work' as const },
    ];
    const [result] = await push(lines);
    expect(result).toMatchObject({ outcome: 'rejected', code: 'CONTRACTOR_QUANTITY_EXCEEDED' });
  });
});

describe('PushSyncUseCase dimensions and planning updates (ADR-056)', () => {
  const ITEM = id(4);
  const DIGGING = id(41);
  const DRAWING = id(60);
  const SITE = id(61);
  const dims = { lengthM: '10', widthM: '0.35', depthM: '0.9' };

  function setup(overrides: Partial<ExecutionTx> = {}) {
    const inserted: NewUpdate[] = [];
    const tx = {
      lockProject: async () => undefined,
      findOperation: async () => null,
      insertOperation: async () => undefined,
      featureExists: async () => true,
      featureInPublishedRevision: async () => ({
        featureType: 'box' as const,
        revisionPublishedAt: new Date(0),
      }),
      featureInScope: async () => true,
      latestPublishedRevision: async () => ({
        id: id(3),
        revNo: 1,
        publishedAt: new Date(0),
        hasTiles: false,
      }),
      featureInRevision: async () => true,
      findItems: async (_project: string, ids: readonly string[]) =>
        [
          { id: ITEM, workType: 'civil' as const, unit: 'م', group: null },
          {
            id: DIGGING,
            workType: 'civil' as const,
            unit: 'م3',
            group: { main: 'حفر', sub: null },
          },
        ].filter((item) => ids.includes(item.id)),
      lockContractorLines: async () => [],
      wouldOverrun: async () => false,
      gpsDistanceM: async () => 0,
      anyPhotoExists: async () => false,
      planningDrawing: async () => ({ drawingId: DRAWING, siteId: SITE }),
      publishedRevisionOfDrawing: async () => ({ publishedAt: new Date(0), crsEpsg: 32636 }),
      insertUpdate: async (update: NewUpdate) => {
        inserted.push(update);
      },
      appendEvent: async () => undefined,
      ...asBuiltStubs,
      ...overrides,
    } as ExecutionTx;
    const useCase = new PushSyncUseCase(
      { run: (work) => work(tx) },
      new Phase2UnavailableCapabilities(),
      { now: () => new Date() },
      { next: () => id(9) },
    );
    const push = (
      payload: Partial<RecordUpdateOp['payload']>,
      scope: ExecutionScope | null = { kind: 'project' },
    ) =>
      useCase.execute({
        projectId: id(10),
        userId: id(11),
        deviceId: id(12),
        scope,
        ops: [{ ...op, payload: { ...op.payload, ...payload } }],
      });
    return { push, inserted };
  }

  const line = (workOrderItemId: string, quantity: string, dimensions: typeof dims | null) => ({
    workOrderItemId,
    quantity,
    role: 'work' as const,
    performer: { kind: 'self' as const },
    dimensions,
  });
  const planning = { featureId: null, drawingId: DRAWING };

  it('requires the dimensions of a digging m3 line', async () => {
    const { push, inserted } = setup();
    const [result] = await push({ lines: [line(DIGGING, '3.15', null)] });
    expect(result).toMatchObject({ outcome: 'rejected', code: 'DIMENSIONS_REQUIRED' });
    expect(inserted).toHaveLength(0);
  });

  it('refuses dimensions on a line that takes none', async () => {
    const { push, inserted } = setup();
    const [result] = await push({ lines: [line(ITEM, '3.15', dims)] });
    expect(result).toMatchObject({ outcome: 'rejected', code: 'DIMENSIONS_NOT_ALLOWED' });
    expect(inserted).toHaveLength(0);
  });

  it('stores the dimensions of a digging line', async () => {
    const { push, inserted } = setup();
    const [result] = await push({ lines: [line(DIGGING, '3.15', dims)] });
    expect(result?.outcome).toBe('applied');
    expect(inserted[0]?.lines[0]?.dimensions).toEqual(dims);
  });

  it('records a planning update on the drawing, with no element and no GPS flag', async () => {
    const { push, inserted } = setup();
    const [result] = await push({ ...planning, lines: [line(ITEM, '1', null)] });
    expect(result?.outcome).toBe('applied');
    expect(inserted[0]).toMatchObject({ featureId: null, featureType: null, drawingId: DRAWING });
    expect(inserted[0]?.flags).toEqual([]);
  });

  it('keeps the element update free of a drawing id', async () => {
    const { push, inserted } = setup();
    await push({ lines: [line(ITEM, '1', null)] });
    expect(inserted[0]).toMatchObject({ featureId: id(2), drawingId: null });
  });

  it('answers DRAWING_NOT_FOUND for an unknown or unpublished drawing', async () => {
    const { push, inserted } = setup({ planningDrawing: async () => null });
    const [result] = await push({ ...planning, lines: [line(ITEM, '1', null)] });
    expect(result).toMatchObject({ outcome: 'rejected', code: 'DRAWING_NOT_FOUND' });
    expect(inserted).toHaveLength(0);
  });

  it('answers DRAWING_OUT_OF_SCOPE for a drawing of another site or without a site', async () => {
    const { push } = setup();
    const lines = [line(ITEM, '1', null)];
    const other = await push({ ...planning, lines }, { kind: 'sites', siteIds: [id(99)] });
    expect(other[0]).toMatchObject({ outcome: 'rejected', code: 'DRAWING_OUT_OF_SCOPE' });
    const none = await push({ ...planning, lines }, { kind: 'sites', siteIds: [] });
    expect(none[0]).toMatchObject({ outcome: 'rejected', code: 'DRAWING_OUT_OF_SCOPE' });
    const noSite = setup({ planningDrawing: async () => ({ drawingId: DRAWING, siteId: null }) });
    const unlinked = await noSite.push({ ...planning, lines }, { kind: 'sites', siteIds: [SITE] });
    expect(unlinked[0]).toMatchObject({ outcome: 'rejected', code: 'DRAWING_OUT_OF_SCOPE' });
    const ok = await push({ ...planning, lines }, { kind: 'sites', siteIds: [SITE] });
    expect(ok[0]?.outcome).toBe('applied');
  });

  it('answers DRAWING_OUT_OF_SCOPE when no assignment grants execution:write', async () => {
    const { push } = setup();
    const [result] = await push({ ...planning, lines: [line(ITEM, '1', null)] }, null);
    expect(result).toMatchObject({ outcome: 'rejected', code: 'DRAWING_OUT_OF_SCOPE' });
  });

  it('answers REVISION_NOT_PUBLISHED when the revision is not a published one of the drawing', async () => {
    const { push } = setup({ publishedRevisionOfDrawing: async () => null });
    const [result] = await push({ ...planning, lines: [line(ITEM, '1', null)] });
    expect(result).toMatchObject({ outcome: 'rejected', code: 'REVISION_NOT_PUBLISHED' });
  });
});

describe('PushSyncUseCase work date (ADR-057)', () => {
  const ITEM = id(4);
  const CL = id(51);
  // 2026-11-11 00:30 in Cairo is still 2026-11-10 in UTC: "today" must be read in Cairo.
  const NOW = new Date('2026-11-10T22:30:00Z');

  function setup(registeredOn = '2026-11-05') {
    const inserted: NewUpdate[] = [];
    const events: { payload: Record<string, unknown> }[] = [];
    const tx = {
      lockProject: async () => undefined,
      findOperation: async () => null,
      insertOperation: async () => undefined,
      featureExists: async () => true,
      featureInPublishedRevision: async () => ({
        featureType: 'box' as const,
        revisionPublishedAt: new Date(0),
      }),
      featureInScope: async () => true,
      latestPublishedRevision: async () => ({
        id: id(3),
        revNo: 1,
        publishedAt: new Date(0),
        hasTiles: false,
      }),
      featureInRevision: async () => true,
      findItems: async () => [{ id: ITEM, workType: 'civil' as const, unit: 'م', group: null }],
      lockContractorLines: async (_project: string, ids: readonly string[]) =>
        ids.includes(CL)
          ? [
              {
                id: CL,
                workOrderItemId: ITEM,
                quantity: '100',
                recordedQuantity: '0',
                registeredOn,
              },
            ]
          : [],
      wouldOverrun: async () => false,
      gpsDistanceM: async () => 0,
      anyPhotoExists: async () => false,
      planningDrawing: async () => null,
      publishedRevisionOfDrawing: async () => null,
      insertUpdate: async (update: NewUpdate) => {
        inserted.push(update);
      },
      appendEvent: async (event: { payload: Record<string, unknown> }) => {
        events.push(event);
      },
      ...asBuiltStubs,
    } as ExecutionTx;
    const useCase = new PushSyncUseCase(
      { run: (work) => work(tx) },
      new Phase2UnavailableCapabilities(),
      { now: () => NOW },
      { next: () => id(9) },
    );
    const push = (
      workDate: string | null,
      performer: RecordUpdateOp['payload']['lines'][number]['performer'] = { kind: 'self' },
      capturedAt = '2026-11-10T22:00:00Z',
    ) =>
      useCase.execute({
        projectId: id(10),
        userId: id(11),
        deviceId: id(12),
        scope: { kind: 'project' },
        ops: [
          {
            ...op,
            capturedAt,
            payload: {
              ...op.payload,
              workDate,
              lines: [
                { workOrderItemId: ITEM, quantity: '1', role: 'work', performer, dimensions: null },
              ],
            },
          },
        ],
      });
    return { push, inserted, events };
  }

  it('records the earlier day the supervisor picked, with no limit on how far back', async () => {
    const { push, inserted, events } = setup();
    const [result] = await push('2025-01-15');
    expect(result?.outcome).toBe('applied');
    expect(inserted[0]?.workDate).toBe('2025-01-15');
    expect(events[0]?.payload.workDate).toBe('2025-01-15');
  });

  it('accepts today read in Cairo, and refuses tomorrow', async () => {
    const today = setup();
    expect((await today.push('2026-11-11'))[0]?.outcome).toBe('applied');
    const tomorrow = setup();
    const [result] = await tomorrow.push('2026-11-12');
    expect(result).toMatchObject({ outcome: 'rejected', code: 'WORK_DATE_IN_FUTURE' });
    expect(tomorrow.inserted).toHaveLength(0);
  });

  it('keeps the Cairo day of capturedAt for an op from a phone built before ADR-057', async () => {
    const { push, inserted } = setup();
    // 22:00 UTC on the 10th = 00:00 on the 11th in Cairo.
    const [result] = await push(null);
    expect(result?.outcome).toBe('applied');
    expect(inserted[0]?.workDate).toBe('2026-11-11');
  });

  it('refuses a contractor registered after the work date', async () => {
    const { push, inserted } = setup('2026-11-05');
    const [result] = await push('2026-11-04', { kind: 'contractor', contractorLineId: CL });
    expect(result).toMatchObject({
      outcome: 'rejected',
      code: 'CONTRACTOR_NOT_REGISTERED_ON_DATE',
    });
    expect(inserted).toHaveLength(0);
  });

  it('accepts the contractor from his registration day on', async () => {
    const { push } = setup('2026-11-05');
    const [result] = await push('2026-11-05', { kind: 'contractor', contractorLineId: CL });
    expect(result?.outcome).toBe('applied');
  });

  it('accepts the own crew on a day before any contractor registration', async () => {
    const { push } = setup('2026-11-05');
    const [result] = await push('2026-11-01', { kind: 'self' });
    expect(result?.outcome).toBe('applied');
  });
});
