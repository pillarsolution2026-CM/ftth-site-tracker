import {
  MAX_CORRECTION_ROWS_PER_FILE,
  MAX_CORRECTIONS_PER_FILE,
  type CadMappingInput,
} from '@ftth/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import type { IdGenerator } from '../../../common/clock.js';
import type { CadFile } from '../domain/cad-file.js';
import { FakeClock, InMemoryCadUnitOfWork, RecordingJobQueue } from '../testing/in-memory.js';
import { SaveCadMappingUseCase } from './cad-mapping.use-cases.js';
import { CreateDesignRevisionUseCase } from './create-design-revision.use-case.js';
import {
  CreateDrawingCorrectionUseCase,
  ListDrawingCorrectionsUseCase,
  WithdrawDrawingCorrectionUseCase,
} from './drawing-correction.use-cases.js';
import { RebuildDesignRevisionUseCase } from './rebuild-design-revision.use-case.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT = '99999999-9999-4999-8999-999999999999';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const FILE = '33333333-3333-4333-8333-333333333333';

let uow: InMemoryCadUnitOfWork;
let queue: RecordingJobQueue;
let clock: FakeClock;
let ids: IdGenerator;

const MAPPING: CadMappingInput = {
  rules: [{ source: 'layer', layer: 'N_DUC_CBL', target: 'route' }],
  crsEpsg: 32636,
  drawingUnit: 'in',
  version: null,
  placement: null,
};

function processedFile(overrides: Partial<CadFile> = {}): CadFile {
  const now = clock.now();
  return {
    id: FILE,
    projectId: PROJECT,
    originalName: 'qalyub.dxf',
    format: 'dxf',
    sizeBytes: 10,
    sha256: 'a'.repeat(64),
    storageKey: 'k',
    convertedStorageKey: null,
    status: 'processed',
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

beforeEach(() => {
  let n = 0;
  ids = { next: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` };
  uow = new InMemoryCadUnitOfWork();
  queue = new RecordingJobQueue();
  clock = new FakeClock(new Date('2026-11-01T10:00:00Z'));
  uow.files.rows.set(FILE, processedFile());
  uow.corrections.handles.set('A1', new Set(['text']));
  uow.corrections.handles.set('A2', new Set(['insert']));
  uow.corrections.handles.set('C1', new Set(['curve']));
  uow.corrections.handles.set('C2', new Set(['curve']));
});

const add = (
  request: Parameters<CreateDrawingCorrectionUseCase['execute']>[0]['request'],
  project = PROJECT,
) =>
  new CreateDrawingCorrectionUseCase(uow, clock, ids).execute({
    projectId: project,
    cadFileId: FILE,
    actorId: ACTOR,
    request,
  });
const withdraw = (correctionId: string, project = PROJECT) =>
  new WithdrawDrawingCorrectionUseCase(uow, clock).execute({
    projectId: project,
    cadFileId: FILE,
    correctionId,
    actorId: ACTOR,
  });
const setText = (handle = 'A1', text = 'x') =>
  add({ correction: { kind: 'set_text', handle, text }, problem: null });

const save = () =>
  new SaveCadMappingUseCase(uow, clock).execute({
    projectId: PROJECT,
    cadFileId: FILE,
    actorId: ACTOR,
    mapping: MAPPING,
  });
const create = () =>
  new CreateDesignRevisionUseCase(uow, queue, clock, ids).execute({
    projectId: PROJECT,
    actorId: ACTOR,
    request: { cadFileId: FILE, mappingVersion: 1 },
  });
const rebuild = (revisionId: string, mappingVersion = 1) =>
  new RebuildDesignRevisionUseCase(uow, queue, clock, ids).execute({
    projectId: PROJECT,
    revisionId,
    actorId: ACTOR,
    request: { mappingVersion },
  });

describe('adding a correction', () => {
  it('stores it with its problem and records the event', async () => {
    const created = await add({
      correction: { kind: 'move_layer', handle: 'A2', toLayer: 'N_MH' },
      problem: { code: 'WRONG_LAYER', handle: 'A2' },
    });
    expect(created.problem).toEqual({ code: 'WRONG_LAYER', handle: 'A2' });
    expect(created.withdrawnAt).toBeNull();
    expect(uow.events.types()).toEqual(['drawing_correction.added']);
  });

  it('accepts add_text and add_item without any handle', async () => {
    await add({
      correction: { kind: 'add_text', layer: 'L', x: 1, y: 2, text: 'MH-1', height: null },
      problem: null,
    });
    await add({ correction: { kind: 'add_item', layer: 'N_MH', x: 1, y: 2 }, problem: null });
    expect(uow.corrections.rows.size).toBe(2);
  });

  it('moves a layer of an insert, a text or a curve', async () => {
    for (const handle of ['A1', 'A2', 'C1']) {
      await add({ correction: { kind: 'move_layer', handle, toLayer: 'L' }, problem: null });
    }
    expect(uow.corrections.rows.size).toBe(3);
  });

  it('refuses set_text on something that is not a text', async () => {
    await expect(setText('A2')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      httpStatus: 422,
      details: { reason: 'HANDLE_NOT_FOUND', handles: ['A2'] },
    });
  });

  it('refuses an unknown handle and a merge with a non-curve', async () => {
    await expect(
      add({ correction: { kind: 'move_layer', handle: 'NOPE', toLayer: 'L' }, problem: null }),
    ).rejects.toMatchObject({ details: { reason: 'HANDLE_NOT_FOUND' } });
    await expect(
      add({ correction: { kind: 'merge_routes', handles: ['C1', 'A1'] }, problem: null }),
    ).rejects.toMatchObject({ details: { reason: 'HANDLE_NOT_FOUND', handles: ['A1'] } });
    expect(uow.corrections.rows.size).toBe(0);
    expect(uow.events.events).toHaveLength(0);
  });

  it('merges curves that exist', async () => {
    const created = await add({
      correction: { kind: 'merge_routes', handles: ['C1', 'C2'] },
      problem: null,
    });
    expect(created.correction.kind).toBe('merge_routes');
  });

  it('refuses a file that is not processed, and another project, as not found', async () => {
    uow.files.rows.set(FILE, processedFile({ status: 'failed' }));
    await expect(setText()).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'NOT_PROCESSED' },
    });
    uow.files.rows.set(FILE, processedFile());
    await expect(
      add(
        { correction: { kind: 'add_item', layer: 'L', x: 0, y: 0 }, problem: null },
        OTHER_PROJECT,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('caps the active corrections per file; withdrawn ones do not count', async () => {
    const first = await setText();
    for (let i = 1; i < MAX_CORRECTIONS_PER_FILE; i++) {
      uow.corrections.rows.set(`id-${i}`, { ...first, id: `id-${i}` });
    }
    await expect(setText()).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'TOO_MANY_CORRECTIONS' },
    });
    await withdraw(first.id);
    await expect(setText()).resolves.toBeDefined();
  });

  it('caps every row ever made, withdrawn ones included (add + withdraw loops stay bounded)', async () => {
    const first = await setText();
    const withdrawnAt = new Date('2026-11-09T00:00:00Z');
    for (let i = 1; i < MAX_CORRECTION_ROWS_PER_FILE; i++) {
      uow.corrections.rows.set(`id-${i}`, { ...first, id: `id-${i}`, withdrawnAt });
    }
    await expect(setText()).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'TOO_MANY_CORRECTIONS' },
    });
  });
});

describe('withdrawing a correction', () => {
  it('withdraws once, with the event', async () => {
    const created = await setText();
    const done = await withdraw(created.id);
    expect(done.withdrawnAt).toEqual(clock.now());
    expect(done.withdrawnBy?.id).toBe(ACTOR);
    expect(uow.events.types()).toEqual([
      'drawing_correction.added',
      'drawing_correction.withdrawn',
    ]);
    await expect(withdraw(created.id)).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'ALREADY_WITHDRAWN' },
    });
  });

  it('does not know another project or an unknown id', async () => {
    const created = await setText();
    await expect(withdraw(created.id, OTHER_PROJECT)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(withdraw('00000000-0000-4000-8000-0000000fffff')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('listing', () => {
  it('lists newest first with the number in force', async () => {
    const a = await setText('A1', 'a');
    clock.advanceMinutes(1);
    const b = await setText('A1', 'b');
    await withdraw(a.id);
    const list = await new ListDrawingCorrectionsUseCase(uow).execute(PROJECT, FILE);
    expect(list.items.map((item) => item.id)).toEqual([b.id, a.id]);
    expect(list.activeCount).toBe(1);
  });

  it('does not list the files of another project', async () => {
    await expect(
      new ListDrawingCorrectionsUseCase(uow).execute(OTHER_PROJECT, FILE),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('freezing on revision creation', () => {
  it('freezes only the active corrections, in creation order', async () => {
    await save();
    const a = await setText('A1', 'a');
    clock.advanceMinutes(1);
    const b = await setText('A1', 'b');
    clock.advanceMinutes(1);
    const c = await add({
      correction: { kind: 'add_item', layer: 'N_MH', x: 1, y: 2 },
      problem: null,
    });
    await withdraw(b.id);
    const revision = await create();
    expect(uow.revisions.frozenCorrections.get(revision.id)).toEqual([
      { id: a.id, correction: a.correction },
      { id: c.id, correction: c.correction },
    ]);
  });

  it('freezes an empty list when there are none, and later changes do not touch it', async () => {
    await save();
    const revision = await create();
    await setText();
    expect(uow.revisions.frozenCorrections.get(revision.id)).toEqual([]);
  });
});

describe('rebuild', () => {
  async function draft() {
    await save();
    const revision = await create();
    uow.revisions.rows.set(revision.id, { ...revision, status: 'draft' });
    return revision;
  }

  it('discards the draft and creates a new revision of the same file with the corrections', async () => {
    const old = await draft();
    const correction = await setText();
    queue.buildJobs.length = 0;
    uow.events.events.length = 0;

    const fresh = await rebuild(old.id);

    expect(fresh.id).not.toBe(old.id);
    expect(fresh.status).toBe('queued');
    expect(fresh.cadFileId).toBe(FILE);
    expect(uow.revisions.rows.get(old.id)?.status).toBe('discarded');
    expect(uow.events.types()).toEqual(['design_revision.discarded', 'design_revision.queued']);
    expect(uow.revisions.frozenCorrections.get(fresh.id)).toEqual([
      { id: correction.id, correction: correction.correction },
    ]);
    expect(queue.buildJobs).toHaveLength(1);
    expect(queue.buildJobs[0]?.revisionId).toBe(fresh.id);
  });

  it('rebuilds a failed revision', async () => {
    const old = await draft();
    uow.revisions.rows.set(old.id, { ...old, status: 'failed', errorCode: 'INTERNAL' });
    const fresh = await rebuild(old.id);
    expect(uow.revisions.rows.get(old.id)?.status).toBe('discarded');
    expect(fresh.status).toBe('queued');
  });

  it('refuses a published, queued or discarded revision', async () => {
    const old = await draft();
    for (const status of ['published', 'queued', 'discarded'] as const) {
      uow.revisions.rows.set(old.id, { ...old, status });
      await expect(rebuild(old.id)).rejects.toMatchObject({
        code: 'CONFLICT',
        details: { reason: 'NOT_REBUILDABLE', status },
      });
    }
  });

  it('keeps the mapping version rule of create', async () => {
    const old = await draft();
    await expect(rebuild(old.id, 7)).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'MAPPING_VERSION_MISMATCH', currentVersion: 1 },
    });
  });

  it('marks the new revision failed when the queue is down', async () => {
    const old = await draft();
    queue.failWith = new Error('redis down');
    const fresh = await rebuild(old.id);
    expect(fresh.status).toBe('failed');
    expect(fresh.errorCode).toBe('ENQUEUE_FAILED');
  });

  it('does not know the revisions of another project', async () => {
    const old = await draft();
    await expect(
      new RebuildDesignRevisionUseCase(uow, queue, clock, ids).execute({
        projectId: OTHER_PROJECT,
        revisionId: old.id,
        actorId: ACTOR,
        request: { mappingVersion: 1 },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
