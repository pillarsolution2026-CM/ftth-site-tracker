import { PlacementSchema, type DrawingKind } from '@ftth/shared';
import { createProjectCrs } from '@ftth/geo';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../../common/app-error.js';
import type { CadFile } from '../domain/cad-file.js';
import type { DesignRevision } from '../domain/design-revision.js';
import { FakeClock, InMemoryCadUnitOfWork } from '../testing/in-memory.js';
import {
  GetSecondaryPlacementSuggestionUseCase,
  MAX_CABINETS_READ,
} from './secondary-placement.use-case.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const GENERAL_FILE = '33333333-3333-4333-8333-333333333333';
const SECONDARY_FILE = '55555555-5555-4555-8555-555555555555';
const GENERAL_REV = '66666666-6666-4666-8666-666666666666';
const SECONDARY_REV = '77777777-7777-4777-8777-777777777777';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const EPSG = 32636;

let uow: InMemoryCadUnitOfWork;
let clock: FakeClock;

const file = (id: string, drawingKind: DrawingKind, overrides: Partial<CadFile> = {}): CadFile => ({
  id,
  projectId: PROJECT,
  originalName: 'plan.dxf',
  format: 'dxf',
  sizeBytes: 10,
  sha256: 'a'.repeat(64),
  storageKey: `projects/${PROJECT}/cad/${id}/original.dxf`,
  convertedStorageKey: null,
  status: 'processed',
  drawingKind,
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
  createdAt: clock.now(),
  updatedAt: clock.now(),
  queuedAt: clock.now(),
  processingStartedAt: clock.now(),
  processedAt: clock.now(),
  ...overrides,
});

const PLACED = PlacementSchema.parse({
  points: [{ id: 'p1', drawing: { x: 1, y: 1 }, lat: 30.9, lon: 32.7, source: 'typed' }],
});

const revision = (
  id: string,
  cadFileId: string,
  drawingKind: DrawingKind,
  overrides: Partial<DesignRevision> = {},
): DesignRevision => ({
  id,
  projectId: PROJECT,
  cadFileId,
  cadFileName: 'plan.dxf',
  drawingKind,
  revNo: null,
  status: 'draft',
  currentJobId: '88888888-8888-4888-8888-888888888888',
  baseRevisionId: null,
  rules: [],
  mappingVersion: 1,
  crsEpsg: EPSG,
  drawingUnit: 'm',
  metresPerUnit: '1',
  placement: drawingKind === 'general' ? PLACED : null,
  installation: null,
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
  ...overrides,
});

const generalCabinet = (code: string | null, x: number, y: number, handle = `G-${code}`) => ({
  code,
  sourceHandle: handle,
  x,
  y,
  attrs: { role: 'sub' },
});
const secondaryCabinet = (
  code: string | null,
  at: { x: number; y: number } | null,
  h?: string,
) => ({
  code,
  sourceHandle: h ?? `S-${code}`,
  x: 0,
  y: 0,
  attrs: { role: 'sub', ...(at ? { drawingAt: at } : {}) },
});

beforeEach(() => {
  clock = new FakeClock(new Date('2026-11-12T10:00:00Z'));
  uow = new InMemoryCadUnitOfWork();
  uow.files.rows.set(GENERAL_FILE, file(GENERAL_FILE, 'general'));
  uow.files.rows.set(SECONDARY_FILE, file(SECONDARY_FILE, 'secondary'));
  uow.revisions.rows.set(GENERAL_REV, revision(GENERAL_REV, GENERAL_FILE, 'general'));
  uow.revisions.rows.set(SECONDARY_REV, revision(SECONDARY_REV, SECONDARY_FILE, 'secondary'));
});

const suggest = (cadFileId = SECONDARY_FILE, project = PROJECT) =>
  new GetSecondaryPlacementSuggestionUseCase(uow).execute(project, cadFileId);
const refusal = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  const app = error as AppError;
  expect(app.code).toBe('CONFLICT');
  return app.details as { reason: string; revisionId: string | null };
};

describe('automatic Secondary placement from the General cabinets (ADR-042 part G)', () => {
  it('matches sub cabinets by name, converts the General anchors to Lat/Lon and lists the rest', async () => {
    uow.revisions.cabinetPositions.set(GENERAL_REV, [
      generalCabinet('1-2', 330100, 3330200),
      generalCabinet('1-1', 330000, 3330000),
      generalCabinet('9-9', 330500, 3330500),
      generalCabinet(null, 330600, 3330600),
    ]);
    uow.revisions.cabinetPositions.set(SECONDARY_REV, [
      secondaryCabinet('1-1', { x: 10, y: 20 }),
      secondaryCabinet('1 - 2', { x: 30, y: 40 }),
      secondaryCabinet('7-7', { x: 1, y: 1 }),
    ]);
    const result = await suggest();
    const crs = createProjectCrs(EPSG);
    expect(result).toMatchObject({
      cadFileId: SECONDARY_FILE,
      secondaryRevisionId: SECONDARY_REV,
      general: { cadFileId: GENERAL_FILE, revisionId: GENERAL_REV, status: 'draft', revNo: null },
      matchedCount: 2,
      truncated: false,
      unmatched: {
        onlyInSecondary: ['7-7'],
        onlyInGeneral: ['9-9'],
        unnamedGeneral: 1,
        unnamedSecondary: 0,
      },
    });
    expect(result.points.map((p) => [p.id, p.label, p.source, p.excluded])).toEqual([
      ['gc-1-1', '1-1', 'general_cabinet', false],
      ['gc-1-2', '1 - 2', 'general_cabinet', false],
    ]);
    expect(result.points[0]).toMatchObject({
      drawing: { x: 10, y: 20 },
      handle: 'S-1-1',
      ...crs.toWgs84({ x: 330000, y: 3330000 }),
    });
  });

  it('does not use a name drawn twice on either side, and lists a cabinet without a drawn centre', async () => {
    uow.revisions.cabinetPositions.set(GENERAL_REV, [
      generalCabinet('1-1', 330000, 3330000),
      generalCabinet('2-1', 330010, 3330010, 'G2a'),
      generalCabinet('2-1', 330020, 3330020, 'G2b'),
      generalCabinet('3-1', 330030, 3330030),
    ]);
    uow.revisions.cabinetPositions.set(SECONDARY_REV, [
      secondaryCabinet('1-1', { x: 1, y: 1 }, 'S1a'),
      secondaryCabinet('1-1', { x: 2, y: 2 }, 'S1b'),
      secondaryCabinet('2-1', { x: 3, y: 3 }),
      secondaryCabinet('3-1', null),
      secondaryCabinet('4-1', { x: 4, y: 4 }),
    ]);
    const result = await suggest();
    expect(result.points).toEqual([]);
    expect(result.unmatched).toMatchObject({
      duplicateInSecondary: ['1-1'],
      duplicateInGeneral: ['2-1'],
      withoutDrawingPosition: ['3-1'],
      onlyInSecondary: ['4-1'],
    });
  });

  it('lists a cabinet that cannot be converted or named instead of failing (L2)', async () => {
    const long = 'n'.repeat(300);
    uow.revisions.cabinetPositions.set(GENERAL_REV, [
      generalCabinet('1-1', 330000, 3330000),
      generalCabinet('2-2', Number.NaN, 3330000),
      generalCabinet(long, 330000, 3330000),
    ]);
    uow.revisions.cabinetPositions.set(SECONDARY_REV, [
      secondaryCabinet('1-1', { x: 1, y: 1 }),
      secondaryCabinet('2-2', { x: 2, y: 2 }),
      secondaryCabinet(long, { x: 3, y: 3 }),
    ]);
    const result = await suggest();
    expect(result.points.map((p) => p.label)).toEqual(['1-1']);
    expect(result.unmatched.unusable).toEqual(['2-2', long.slice(0, 200)]);
    expect(result.unmatched.listCapped).toBe(false);
  });

  it('flags a capped read (L1)', async () => {
    uow.revisions.cabinetPositions.set(
      SECONDARY_REV,
      Array.from({ length: MAX_CABINETS_READ + 1 }, (_, i) =>
        secondaryCabinet(`c${i}`, { x: i, y: i }),
      ),
    );
    expect((await suggest()).unmatched.listCapped).toBe(true);
  });

  it('uses the latest published General when it is the built one', async () => {
    uow.revisions.rows.set(
      GENERAL_REV,
      revision(GENERAL_REV, GENERAL_FILE, 'general', { status: 'published', revNo: 3 }),
    );
    uow.revisions.cabinetPositions.set(SECONDARY_REV, [secondaryCabinet('1-1', { x: 1, y: 1 })]);
    expect((await suggest()).general).toMatchObject({ status: 'published', revNo: 3 });
  });

  it('refuses a General file as NOT_SECONDARY and a superseded one as NOT_CURRENT', async () => {
    expect(await refusal(suggest(GENERAL_FILE))).toMatchObject({ reason: 'NOT_SECONDARY' });
    uow.files.rows.set(
      SECONDARY_FILE,
      file(SECONDARY_FILE, 'secondary', { supersededAt: clock.now() }),
    );
    expect(await refusal(suggest())).toMatchObject({ reason: 'NOT_CURRENT' });
  });

  it('answers 404 for another project', async () => {
    const error = await suggest(SECONDARY_FILE, '99999999-9999-4999-8999-999999999999').catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses the Secondary side: building, not built, built before drawingAt', async () => {
    uow.revisions.rows.set(
      SECONDARY_REV,
      revision(SECONDARY_REV, SECONDARY_FILE, 'secondary', { status: 'building' }),
    );
    expect(await refusal(suggest())).toEqual({
      reason: 'SECONDARY_BUILDING',
      revisionId: SECONDARY_REV,
    });
    uow.revisions.rows.delete(SECONDARY_REV);
    expect(await refusal(suggest())).toMatchObject({ reason: 'SECONDARY_NOT_BUILT' });
    uow.revisions.rows.set(SECONDARY_REV, revision(SECONDARY_REV, SECONDARY_FILE, 'secondary'));
    uow.revisions.cabinetPositions.set(SECONDARY_REV, [
      secondaryCabinet('1-1', null),
      secondaryCabinet('1-2', null),
    ]);
    expect(await refusal(suggest())).toEqual({
      reason: 'SECONDARY_REBUILD_NEEDED',
      revisionId: SECONDARY_REV,
    });
  });

  it('refuses the General side: no file, building, not built, not placed', async () => {
    uow.revisions.cabinetPositions.set(SECONDARY_REV, [secondaryCabinet('1-1', { x: 1, y: 1 })]);
    uow.revisions.rows.set(
      GENERAL_REV,
      revision(GENERAL_REV, GENERAL_FILE, 'general', { status: 'queued' }),
    );
    expect(await refusal(suggest())).toEqual({
      reason: 'GENERAL_BUILDING',
      revisionId: GENERAL_REV,
    });
    uow.revisions.rows.delete(GENERAL_REV);
    expect(await refusal(suggest())).toMatchObject({ reason: 'GENERAL_NOT_BUILT' });
    uow.files.rows.delete(GENERAL_FILE);
    expect(await refusal(suggest())).toMatchObject({ reason: 'GENERAL_NOT_BUILT' });

    uow.files.rows.set(GENERAL_FILE, file(GENERAL_FILE, 'general'));
    for (const placement of [
      null,
      PlacementSchema.parse({}),
      PlacementSchema.parse({
        points: [
          {
            id: 'p1',
            drawing: { x: 1, y: 1 },
            lat: 30.9,
            lon: 32.7,
            source: 'typed',
            excluded: true,
          },
        ],
      }),
    ]) {
      uow.revisions.rows.set(
        GENERAL_REV,
        revision(GENERAL_REV, GENERAL_FILE, 'general', { placement }),
      );
      expect(await refusal(suggest())).toEqual({
        reason: 'GENERAL_NOT_PLACED',
        revisionId: GENERAL_REV,
      });
    }
  });

  it('reads the General from the CURRENT General file, not a superseded one', async () => {
    const OLD = '12121212-1212-4212-8212-121212121212';
    uow.files.rows.set(
      OLD,
      file(OLD, 'general', {
        supersededAt: clock.now(),
        createdAt: new Date(clock.now().getTime() - 60_000),
      }),
    );
    uow.revisions.rows.set(
      '13131313-1313-4313-8313-131313131313',
      revision('13131313-1313-4313-8313-131313131313', OLD, 'general'),
    );
    uow.revisions.cabinetPositions.set(SECONDARY_REV, [secondaryCabinet('1-1', { x: 1, y: 1 })]);
    expect((await suggest()).general.revisionId).toBe(GENERAL_REV);
  });
});
