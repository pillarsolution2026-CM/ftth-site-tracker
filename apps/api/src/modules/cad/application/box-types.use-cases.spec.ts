import {
  EVENT_TYPES,
  MAX_BOX_TYPE_CHOICE_ROWS_PER_FILE,
  MappingRuleSchema,
  type BoxShapeGallery,
  type DrawingKind,
} from '@ftth/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../../common/app-error.js';
import type { IdGenerator } from '../../../common/clock.js';
import type { CadFile } from '../domain/cad-file.js';
import type { DesignRevision } from '../domain/design-revision.js';
import {
  FakeClock,
  InMemoryCadUnitOfWork,
  InMemoryWorkOrderLines,
  RecordingJobQueue,
} from '../testing/in-memory.js';
import {
  GetBoxTypeStateUseCase,
  GetRevisionBoxTypesUseCase,
  SetBoxTypesUseCase,
  freezeBoxTypes,
} from './box-types.use-cases.js';
import { CreateDesignRevisionUseCase } from './create-design-revision.use-case.js';
import { GetPublishReadinessUseCase } from './publish-design-revision.use-case.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT = '99999999-9999-4999-8999-999999999999';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const GENERAL = '33333333-3333-4333-8333-333333333333';
const SECONDARY = '55555555-5555-4555-8555-555555555555';
const OLD_SECONDARY = '66666666-6666-4666-8666-666666666666';
const LINE_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const LINE_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const LINE_GONE = 'cccccccc-0000-4000-8000-00000000000c';
const SHAPE_1 = `v1-${'1'.repeat(64)}`;
const SHAPE_2 = `v1-${'2'.repeat(64)}`;
const SHAPE_X = `v1-${'f'.repeat(64)}`;

const ROLES_RULES = [
  MappingRuleSchema.parse({
    source: 'layer',
    layer: 'BOXES',
    target: 'box',
    textRoles: ['box_cable_type'],
  }),
];

let uow: InMemoryCadUnitOfWork;
let clock: FakeClock;
let ids: IdGenerator;
let lines: InMemoryWorkOrderLines;

function file(id: string, kind: DrawingKind, overrides: Partial<CadFile> = {}): CadFile {
  const now = clock.now();
  return {
    id,
    projectId: PROJECT,
    originalName: 'plan.dxf',
    format: 'dxf',
    sizeBytes: 10,
    sha256: 'a'.repeat(64),
    storageKey: `projects/${PROJECT}/cad/${id}/original.dxf`,
    convertedStorageKey: null,
    status: 'processed',
    drawingKind: kind,
    supersededAt: null,
    supersededById: null,
    currentJobId: '44444444-4444-4444-8444-444444444444',
    converter: 'none',
    converterVersion: null,
    dxfVersion: 'AC1032',
    insUnits: 1,
    extents: null,
    crsDetection: null,
    counts: null,
    warnings: [],
    errorCode: null,
    errorMessage: null,
    uploadedById: ACTOR,
    createdAt: now,
    updatedAt: now,
    queuedAt: now,
    processingStartedAt: now,
    processedAt: now,
    ...overrides,
  };
}

const gallery = (shapes: [string, number][], extra: Partial<BoxShapeGallery> = {}) => ({
  version: 1,
  boxCount: shapes.reduce((n, [, count]) => n + count, 0),
  shapeCount: shapes.length,
  shapes: shapes.map(([shape, count]) => ({
    shape,
    source: 'block' as const,
    count,
    blockNames: ['box c'],
    sampleHandles: ['A1'],
    preview: null,
  })),
  boxesWithoutShape: 0,
  ...extra,
});

beforeEach(() => {
  let n = 0;
  ids = { next: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` };
  uow = new InMemoryCadUnitOfWork();
  clock = new FakeClock(new Date('2026-11-12T10:00:00Z'));
  lines = new InMemoryWorkOrderLines();
  lines.lines = [
    { id: LINE_A, code: '1.1', description: '  Box   8 branches\nsplitter 4 ' },
    { id: LINE_B, code: '1.2', description: 'Box 4 branches' },
  ];
  uow.files.rows.set(GENERAL, file(GENERAL, 'general'));
  uow.files.rows.set(SECONDARY, file(SECONDARY, 'secondary'));
  uow.boxTypes.galleries.set(
    SECONDARY,
    gallery([
      [SHAPE_1, 150],
      [SHAPE_2, 47],
    ]),
  );
});

const set = (
  choices: { shape: string; workOrderLineId: string | null }[],
  options: { cadFileId?: string; fromPreviousVersion?: boolean } = {},
) => {
  clock.advanceMinutes(1);
  return new SetBoxTypesUseCase(uow, lines, clock, ids).execute({
    projectId: PROJECT,
    cadFileId: options.cadFileId ?? SECONDARY,
    actorId: ACTOR,
    request: { choices, fromPreviousVersion: options.fromPreviousVersion ?? false },
  });
};
const state = (cadFileId = SECONDARY, project = PROJECT) =>
  new GetBoxTypeStateUseCase(uow).execute(project, cadFileId);
const refusal = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
};

describe('set box types (ADR-043)', () => {
  it('writes one row per changed shape, in one call, with one event each', async () => {
    const result = await set([
      { shape: SHAPE_1, workOrderLineId: LINE_A },
      { shape: SHAPE_2, workOrderLineId: LINE_B },
    ]);
    expect(result.history.map((r) => [r.shape, r.workOrderLineId])).toEqual([
      [SHAPE_2, LINE_B],
      [SHAPE_1, LINE_A],
    ]);
    const events = uow.events.events.filter((e) => e.type === EVENT_TYPES.boxTypeChosen);
    expect(events).toHaveLength(2);
    expect(events[0]?.payload).toEqual({
      cadFileId: SECONDARY,
      shape: SHAPE_1,
      workOrderLineId: LINE_A,
      previousWorkOrderLineId: null,
      fromPreviousVersion: false,
    });
  });

  it('writes nothing for a choice equal to the one in force, and records changes and clears', async () => {
    await set([{ shape: SHAPE_1, workOrderLineId: LINE_A }]);
    const same = await set([{ shape: SHAPE_1, workOrderLineId: LINE_A }]);
    expect(same.history).toHaveLength(1);
    // Clearing an unset shape is also nothing.
    expect((await set([{ shape: SHAPE_2, workOrderLineId: null }])).history).toHaveLength(1);

    const changed = await set([{ shape: SHAPE_1, workOrderLineId: LINE_B }]);
    expect(changed.history).toHaveLength(2);
    const cleared = await set([{ shape: SHAPE_1, workOrderLineId: null }]);
    expect(cleared.history).toHaveLength(3);
    const last = uow.events.events.at(-1);
    expect(last?.payload).toMatchObject({
      workOrderLineId: null,
      previousWorkOrderLineId: LINE_B,
    });
  });

  it('records fromPreviousVersion in the events', async () => {
    await set([{ shape: SHAPE_1, workOrderLineId: LINE_A }], { fromPreviousVersion: true });
    expect(uow.events.events.at(-1)?.payload).toMatchObject({ fromPreviousVersion: true });
  });

  it('refuses a General', async () => {
    const error = await refusal(
      set([{ shape: SHAPE_1, workOrderLineId: LINE_A }], { cadFileId: GENERAL }),
    );
    expect(error.details).toMatchObject({ reason: 'NOT_SECONDARY_DRAWING' });
  });

  it('refuses a superseded file', async () => {
    uow.files.rows.set(
      SECONDARY,
      file(SECONDARY, 'secondary', { supersededAt: clock.now(), supersededById: OLD_SECONDARY }),
    );
    const error = await refusal(set([{ shape: SHAPE_1, workOrderLineId: LINE_A }]));
    expect(error.details).toMatchObject({ reason: 'FILE_SUPERSEDED' });
  });

  it('refuses a file with no built revision gallery', async () => {
    uow.boxTypes.galleries.clear();
    const error = await refusal(set([{ shape: SHAPE_1, workOrderLineId: LINE_A }]));
    expect(error.details).toMatchObject({ reason: 'NOT_BUILT' });
  });

  it('refuses shapes that are not in the gallery (422), writing nothing', async () => {
    const error = await refusal(
      set([
        { shape: SHAPE_1, workOrderLineId: LINE_A },
        { shape: SHAPE_X, workOrderLineId: LINE_A },
      ]),
    );
    expect(error.details).toMatchObject({ reason: 'SHAPE_NOT_FOUND', shapes: [SHAPE_X] });
    expect(error.httpStatus).toBe(422);
    expect(uow.boxTypes.rows).toHaveLength(0);
  });

  it('refuses a project without a work order', async () => {
    lines.exists = false;
    lines.lines = [];
    const error = await refusal(set([{ shape: SHAPE_1, workOrderLineId: LINE_A }]));
    expect(error.details).toMatchObject({ reason: 'NO_WORK_ORDER' });
  });

  it('refuses lines that are not lines of the work order (422), but clearing needs none', async () => {
    const error = await refusal(
      set([
        { shape: SHAPE_1, workOrderLineId: LINE_A },
        { shape: SHAPE_2, workOrderLineId: LINE_GONE },
      ]),
    );
    expect(error.details).toMatchObject({
      reason: 'LINE_NOT_IN_WORK_ORDER',
      workOrderLineIds: [LINE_GONE],
    });
    expect(error.httpStatus).toBe(422);
    expect(uow.boxTypes.rows).toHaveLength(0);
    lines.exists = false;
    lines.lines = [];
    await expect(set([{ shape: SHAPE_1, workOrderLineId: null }])).resolves.toBeDefined();
  });

  it('refuses another project (the file is not found)', async () => {
    const error = await refusal(
      new SetBoxTypesUseCase(uow, lines, clock, ids).execute({
        projectId: OTHER_PROJECT,
        cadFileId: SECONDARY,
        actorId: ACTOR,
        request: {
          choices: [{ shape: SHAPE_1, workOrderLineId: LINE_A }],
          fromPreviousVersion: false,
        },
      }),
    );
    expect(error.code).toBe('NOT_FOUND');
    expect((await refusal(state(SECONDARY, OTHER_PROJECT))).code).toBe('NOT_FOUND');
  });

  it('stops at the row cap', async () => {
    for (let i = 0; i < MAX_BOX_TYPE_CHOICE_ROWS_PER_FILE; i += 1) {
      uow.boxTypes.rows.push({
        id: `00000000-0000-4000-9000-${String(i).padStart(12, '0')}`,
        projectId: PROJECT,
        cadFileId: SECONDARY,
        shape: SHAPE_2,
        workOrderLineId: i % 2 === 0 ? LINE_A : LINE_B,
        createdBy: null,
        createdAt: clock.now(),
      });
    }
    const error = await refusal(set([{ shape: SHAPE_1, workOrderLineId: LINE_A }]));
    expect(error.details).toMatchObject({ reason: 'TOO_MANY_CHOICES' });
  });
});

describe('box type state', () => {
  it('lists the choices in force without cleared shapes, and offers the previous version', async () => {
    await set([
      { shape: SHAPE_1, workOrderLineId: LINE_A },
      { shape: SHAPE_2, workOrderLineId: LINE_B },
    ]);
    await set([{ shape: SHAPE_2, workOrderLineId: null }]);
    uow.boxTypes.previousFiles.set(SECONDARY, OLD_SECONDARY);
    uow.boxTypes.rows.push({
      id: '00000000-0000-4000-9999-000000000001',
      projectId: PROJECT,
      cadFileId: OLD_SECONDARY,
      shape: SHAPE_2,
      workOrderLineId: LINE_B,
      createdBy: null,
      createdAt: clock.now(),
    });
    uow.mappings.rows.set(SECONDARY, {
      cadFileId: SECONDARY,
      projectId: PROJECT,
      rules: ROLES_RULES,
      crsEpsg: 32636,
      drawingUnit: 'm',
      metresPerUnit: '1',
      placement: null,
      version: 1,
      updatedById: ACTOR,
      updatedAt: clock.now(),
    });
    const current = await state();
    expect(current.applies).toBe(true);
    expect(current.history).toHaveLength(3);
    expect(current.previousVersion).toEqual({
      cadFileId: OLD_SECONDARY,
      choices: [{ shape: SHAPE_2, workOrderLineId: LINE_B }],
    });
  });

  it('is empty and not applicable for a General', async () => {
    const result = await state(GENERAL);
    expect(result).toMatchObject({ applies: false, history: [], previousVersion: null });
  });
});

describe('freezing and checking (ADR-043)', () => {
  const rolesMapping = () =>
    uow.mappings.rows.set(SECONDARY, {
      cadFileId: SECONDARY,
      projectId: PROJECT,
      rules: ROLES_RULES,
      crsEpsg: 32636,
      drawingUnit: 'm',
      metresPerUnit: '1',
      placement: null,
      version: 1,
      updatedById: ACTOR,
      updatedAt: clock.now(),
    });

  it('freezes the choices in force with the snapshot of their lines, label collapsed', async () => {
    await set([
      { shape: SHAPE_2, workOrderLineId: LINE_B },
      { shape: SHAPE_1, workOrderLineId: LINE_A },
    ]);
    const frozen = await uow.run((tx) =>
      freezeBoxTypes(tx, lines, file(SECONDARY, 'secondary'), ROLES_RULES),
    );
    expect(frozen?.choices.map((c) => [c.shape, c.workOrderLineId, c.line?.code])).toEqual([
      [SHAPE_1, LINE_A, '1.1'],
      [SHAPE_2, LINE_B, '1.2'],
    ]);
    expect(frozen?.choices[0]?.line?.label).toBe('Box 8 branches splitter 4');
  });

  it('freezes null for a General and for legacy reading mode, empty when nothing is chosen', async () => {
    await set([{ shape: SHAPE_1, workOrderLineId: LINE_A }]);
    const run = (f: CadFile, rules: typeof ROLES_RULES) =>
      uow.run((tx) => freezeBoxTypes(tx, lines, f, rules));
    expect(await run(file(GENERAL, 'general'), ROLES_RULES)).toBeNull();
    expect(await run(file(SECONDARY, 'secondary'), [])).toBeNull();
    expect(await run(file(OLD_SECONDARY, 'secondary'), ROLES_RULES)).toEqual({ choices: [] });
  });

  it('freezes a null line snapshot when the chosen line is already gone', async () => {
    await set([{ shape: SHAPE_1, workOrderLineId: LINE_A }]);
    lines.lines = [];
    const frozen = await uow.run((tx) =>
      freezeBoxTypes(tx, lines, file(SECONDARY, 'secondary'), ROLES_RULES),
    );
    expect(frozen?.choices[0]?.line).toBeNull();
  });

  it('createRevision freezes box types; the revision report and readiness see the issues', async () => {
    rolesMapping();
    await set([{ shape: SHAPE_1, workOrderLineId: LINE_A }]);
    const queue = new RecordingJobQueue();
    const revision = await new CreateDesignRevisionUseCase(uow, queue, clock, ids, lines).execute({
      projectId: PROJECT,
      actorId: ACTOR,
      request: { cadFileId: SECONDARY, mappingVersion: 1 },
    });
    expect(revision.boxTypes?.choices).toHaveLength(1);

    // The worker finished: a draft with the gallery.
    const draft: DesignRevision = {
      ...revision,
      status: 'draft',
      boxShapes: gallery([
        [SHAPE_1, 150],
        [SHAPE_2, 47],
      ]),
    };
    uow.revisions.rows.set(draft.id, draft);

    const report = await new GetRevisionBoxTypesUseCase(uow, lines).execute(PROJECT, draft.id);
    expect(report).toMatchObject({
      applies: true,
      ok: false,
      issueCount: 1,
      issues: [{ code: 'BOX_TYPE_UNSET', shape: SHAPE_2, boxCount: 47 }],
      totals: null,
      changedSinceBuild: false,
    });

    const readiness = await new GetPublishReadinessUseCase(uow, lines).execute(PROJECT, draft.id);
    expect(readiness.checks.find((c) => c.key === 'box_types')).toEqual({
      key: 'box_types',
      ok: false,
      count: 1,
    });
    expect(readiness.boxTypes).toMatchObject({ applies: true, issueCount: 1 });
    expect(readiness.canPublish).toBe(false);
    expect(readiness.checks.at(-1)?.key).toBe('box_types');

    // A later choice is a change since the build; choosing both makes it ok with totals.
    await set([{ shape: SHAPE_2, workOrderLineId: LINE_A }]);
    expect(
      (await new GetRevisionBoxTypesUseCase(uow, lines).execute(PROJECT, draft.id))
        .changedSinceBuild,
    ).toBe(true);
  });

  it('reports every kind of issue and totals only when clear', async () => {
    rolesMapping();
    const make = (patch: Partial<DesignRevision>): DesignRevision => ({
      id: '77777777-7777-4777-8777-777777777777',
      projectId: PROJECT,
      cadFileId: SECONDARY,
      cadFileName: 'plan.dxf',
      drawingKind: 'secondary',
      revNo: null,
      status: 'draft',
      currentJobId: '88888888-8888-4888-8888-888888888888',
      baseRevisionId: null,
      rules: ROLES_RULES,
      mappingVersion: 1,
      crsEpsg: 32636,
      drawingUnit: 'm',
      metresPerUnit: '1',
      placement: null,
      installation: null,
      boxTypes: { choices: [] },
      boxShapes: null,
      insUnits: 1,
      unitsConflict: false,
      counts: null,
      textLinkCounts: null,
      diffCounts: null,
      tilesStorageKey: null,
      errorCode: null,
      errorMessage: null,
      log: null,
      createdById: ACTOR,
      createdAt: clock.now(),
      queuedAt: clock.now(),
      buildStartedAt: null,
      builtAt: null,
      publishedAt: null,
      publishedById: null,
      ...patch,
    });
    const run = async (patch: Partial<DesignRevision>) => {
      const revision = make(patch);
      uow.revisions.rows.set(revision.id, revision);
      return new GetRevisionBoxTypesUseCase(uow, lines).execute(PROJECT, revision.id);
    };
    const frozen = (shape: string, lineId: string) => ({
      choiceId: ids.next(),
      shape,
      workOrderLineId: lineId,
      line: { code: '1.1', description: 'd', label: 'd' },
    });

    expect((await run({ boxShapes: null })).issues.map((i) => i.code)).toEqual([
      'BOX_SHAPES_NOT_READ',
    ]);
    expect(
      (await run({ boxShapes: gallery([[SHAPE_1, 1]], { boxesWithoutShape: 3 }) })).issues.map(
        (i) => i.code,
      ),
    ).toEqual(['BOX_SHAPE_UNKNOWN', 'BOX_TYPE_UNSET']);
    expect(
      (
        await run({
          boxShapes: gallery([[SHAPE_1, 1]], { shapeCount: 201 }),
          boxTypes: { choices: [frozen(SHAPE_1, LINE_A)] },
        })
      ).issues.map((i) => i.code),
    ).toEqual(['BOX_SHAPES_TOO_MANY']);

    // A line removed after the build: BOX_TYPE_LINE_MISSING.
    const missing = await run({
      boxShapes: gallery([[SHAPE_1, 5]]),
      boxTypes: { choices: [frozen(SHAPE_1, LINE_GONE)] },
    });
    expect(missing.issues).toEqual([
      { code: 'BOX_TYPE_LINE_MISSING', shape: SHAPE_1, boxCount: 5, workOrderLineId: LINE_GONE },
    ]);

    lines.exists = false;
    lines.lines = [];
    expect(
      (
        await run({
          boxShapes: gallery([[SHAPE_1, 5]]),
          boxTypes: { choices: [frozen(SHAPE_1, LINE_A)] },
        })
      ).issues.map((i) => i.code),
    ).toEqual(['WORK_ORDER_MISSING', 'BOX_TYPE_LINE_MISSING']);

    lines.exists = true;
    lines.lines = [{ id: LINE_A, code: '1.1', description: 'd' }];
    const clear = await run({
      boxShapes: gallery([
        [SHAPE_1, 5],
        [SHAPE_2, 7],
      ]),
      boxTypes: { choices: [frozen(SHAPE_1, LINE_A), frozen(SHAPE_2, LINE_A)] },
    });
    expect(clear).toMatchObject({ ok: true, issueCount: 0 });
    expect(clear.totals).toEqual([
      {
        workOrderLineId: LINE_A,
        code: '1.1',
        label: 'd',
        boxCount: 12,
        shapes: [SHAPE_1, SHAPE_2],
      },
    ]);
  });
});
