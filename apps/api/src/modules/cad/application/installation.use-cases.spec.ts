import {
  MAX_INSTALLATION_ANSWERS_PER_FILE,
  MAX_TRENCH_MARKS_PER_FILE,
  MAX_TRENCH_MARK_ROWS_PER_FILE,
} from '@ftth/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../../common/app-error.js';
import type { IdGenerator } from '../../../common/clock.js';
import type { CadFile } from '../domain/cad-file.js';
import { FakeClock, InMemoryCadUnitOfWork } from '../testing/in-memory.js';
import {
  AddTrenchMarkUseCase,
  GetInstallationUseCase,
  SetInstallationAnswerUseCase,
  WithdrawTrenchMarkUseCase,
} from './installation.use-cases.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT = '99999999-9999-4999-8999-999999999999';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const GENERAL = '33333333-3333-4333-8333-333333333333';
const SECONDARY = '55555555-5555-4555-8555-555555555555';

let uow: InMemoryCadUnitOfWork;
let clock: FakeClock;
let ids: IdGenerator;

function file(id: string, overrides: Partial<CadFile> = {}): CadFile {
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
    drawingKind: 'general',
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

beforeEach(() => {
  let n = 0;
  ids = { next: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` };
  uow = new InMemoryCadUnitOfWork();
  clock = new FakeClock(new Date('2026-11-12T10:00:00Z'));
  uow.files.rows.set(GENERAL, file(GENERAL));
  uow.files.rows.set(SECONDARY, file(SECONDARY, { drawingKind: 'secondary' }));
  uow.installation.curves.add('A1');
});

const answer = (value: 'pull_only' | 'has_trench', cadFileId = GENERAL, project = PROJECT) => {
  clock.advanceMinutes(1);
  return new SetInstallationAnswerUseCase(uow, clock, ids).execute({
    projectId: project,
    cadFileId,
    actorId: ACTOR,
    request: { answer: value },
  });
};
const mark = (routeHandle = 'A1', lengthM = '12.500', cadFileId = GENERAL, project = PROJECT) => {
  clock.advanceMinutes(1);
  return new AddTrenchMarkUseCase(uow, clock, ids).execute({
    projectId: project,
    cadFileId,
    actorId: ACTOR,
    request: { routeHandle, lengthM },
  });
};
const withdraw = (markId: string, project = PROJECT) =>
  new WithdrawTrenchMarkUseCase(uow, clock).execute({
    projectId: project,
    cadFileId: GENERAL,
    markId,
    actorId: ACTOR,
  });
const reason = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
};

describe('installation answer (ADR-042)', () => {
  it('appends each change as a new row and writes an event with the previous answer', async () => {
    const first = await answer('has_trench');
    expect(first).toMatchObject({ answer: 'has_trench', createdBy: { id: ACTOR } });
    const second = await answer('pull_only');
    expect(second.id).not.toBe(first.id);
    const state = await new GetInstallationUseCase(uow).execute(PROJECT, GENERAL);
    expect(state.answers.map((a) => a.answer)).toEqual(['pull_only', 'has_trench']);
    const events = uow.events.events.filter((e) => e.type === 'installation_answer.answered');
    expect(events.map((e) => e.payload)).toEqual([
      { cadFileId: GENERAL, answer: 'has_trench', previousAnswer: null },
      { cadFileId: GENERAL, answer: 'pull_only', previousAnswer: 'has_trench' },
    ]);
  });

  it('answers the same value again without a new row or event', async () => {
    const first = await answer('pull_only');
    expect(await answer('pull_only')).toEqual(first);
    expect(uow.installation.answers.size).toBe(1);
    expect(uow.events.types()).toEqual(['installation_answer.answered']);
  });

  it('refuses pull_only while marks are in force, then accepts it once they are withdrawn', async () => {
    await answer('has_trench');
    const created = await mark();
    expect((await reason(answer('pull_only'))).details).toMatchObject({
      reason: 'TRENCH_MARKS_ACTIVE',
    });
    await withdraw(created.id);
    expect(await answer('pull_only')).toMatchObject({ answer: 'pull_only' });
  });

  it('refuses a Secondary, a superseded file and another project', async () => {
    expect((await reason(answer('pull_only', SECONDARY))).details).toMatchObject({
      reason: 'NOT_GENERAL_DRAWING',
    });
    uow.files.rows.set(GENERAL, file(GENERAL, { supersededAt: clock.now() }));
    expect((await reason(answer('pull_only'))).details).toMatchObject({
      reason: 'FILE_SUPERSEDED',
    });
    expect((await reason(answer('pull_only', GENERAL, OTHER_PROJECT))).code).toBe('NOT_FOUND');
    expect(uow.installation.answers.size).toBe(0);
  });

  it('stops at the answer cap', async () => {
    for (let i = 0; i < MAX_INSTALLATION_ANSWERS_PER_FILE; i += 1) {
      await answer(i % 2 === 0 ? 'has_trench' : 'pull_only');
    }
    expect((await reason(answer('has_trench'))).details).toMatchObject({
      reason: 'TOO_MANY_ANSWERS',
    });
  });
});

describe('trench marks (ADR-042)', () => {
  it('adds a mark only after has_trench, on a curve of the file', async () => {
    expect((await reason(mark())).details).toMatchObject({
      reason: 'ANSWER_NOT_TRENCH',
      answer: null,
    });
    await answer('pull_only');
    expect((await reason(mark())).details).toMatchObject({ reason: 'ANSWER_NOT_TRENCH' });
    await answer('has_trench');
    const unknown = await reason(mark('NOPE'));
    expect(unknown.httpStatus).toBe(422);
    expect(unknown.details).toMatchObject({ reason: 'ROUTE_NOT_FOUND', handle: 'NOPE' });
    const created = await mark('A1', '12.500');
    expect(created).toMatchObject({
      routeHandle: 'A1',
      lengthM: '12.500',
      createdBy: { id: ACTOR },
      withdrawnAt: null,
    });
    const event = uow.events.events.find((e) => e.type === 'trench_mark.added');
    expect(event).toMatchObject({
      entity: 'trench_mark',
      entityId: created.id,
      payload: { cadFileId: GENERAL, routeHandle: 'A1', lengthM: '12.500' },
    });
  });

  it('allows several marks on one route', async () => {
    await answer('has_trench');
    await mark('A1', '1.000');
    await mark('A1', '2.000');
    expect(await uow.installation.countActiveMarks(PROJECT, GENERAL)).toBe(2);
  });

  it('refuses a Secondary, a superseded file, an unprocessed file and another project', async () => {
    await answer('has_trench');
    expect((await reason(mark('A1', '1.000', SECONDARY))).details).toMatchObject({
      reason: 'NOT_GENERAL_DRAWING',
    });
    expect((await reason(mark('A1', '1.000', GENERAL, OTHER_PROJECT))).code).toBe('NOT_FOUND');
    uow.files.rows.set(GENERAL, file(GENERAL, { status: 'processing' }));
    expect((await reason(mark())).details).toMatchObject({ reason: 'NOT_PROCESSED' });
    uow.files.rows.set(GENERAL, file(GENERAL, { supersededAt: clock.now() }));
    expect((await reason(mark())).details).toMatchObject({ reason: 'FILE_SUPERSEDED' });
  });

  it('stops at the active cap and at the row cap', async () => {
    await answer('has_trench');
    const seed = (n: number, withdrawn: boolean) => {
      for (let i = 0; i < n; i += 1) {
        const id = `00000000-0000-4000-9000-${String(uow.installation.marks.size).padStart(12, '0')}`;
        uow.installation.marks.set(id, {
          id,
          projectId: PROJECT,
          cadFileId: GENERAL,
          routeHandle: 'A1',
          lengthM: '1.000',
          createdBy: null,
          createdAt: clock.now(),
          withdrawnBy: withdrawn ? { id: ACTOR, name: 'PM' } : null,
          withdrawnAt: withdrawn ? clock.now() : null,
        });
      }
    };
    seed(MAX_TRENCH_MARKS_PER_FILE, false);
    expect((await reason(mark())).details).toMatchObject({ reason: 'TOO_MANY_MARKS' });
    uow.installation.marks.clear();
    seed(MAX_TRENCH_MARK_ROWS_PER_FILE, true);
    expect((await reason(mark())).details).toMatchObject({ reason: 'TOO_MANY_MARKS' });
  });

  it('withdraws a mark once and writes an event; never deletes it', async () => {
    await answer('has_trench');
    const created = await mark();
    clock.advanceMinutes(1);
    const withdrawn = await withdraw(created.id);
    expect(withdrawn).toMatchObject({ withdrawnBy: { id: ACTOR }, withdrawnAt: clock.now() });
    expect((await reason(withdraw(created.id))).details).toMatchObject({
      reason: 'ALREADY_WITHDRAWN',
    });
    expect(uow.installation.marks.size).toBe(1);
    expect(uow.events.types()).toEqual([
      'installation_answer.answered',
      'trench_mark.added',
      'trench_mark.withdrawn',
    ]);
  });

  it('refuses to withdraw a mark of a superseded General (L3)', async () => {
    await answer('has_trench');
    const created = await mark();
    uow.files.rows.set(GENERAL, file(GENERAL, { supersededAt: clock.now() }));
    expect((await reason(withdraw(created.id))).details).toMatchObject({
      reason: 'FILE_SUPERSEDED',
    });
    expect(uow.installation.marks.get(created.id)?.withdrawnAt).toBeNull();
  });

  it('answers 404 for an unknown mark and for another project', async () => {
    await answer('has_trench');
    const created = await mark();
    expect((await reason(withdraw('00000000-0000-4000-8000-0000000000ff'))).code).toBe('NOT_FOUND');
    expect((await reason(withdraw(created.id, OTHER_PROJECT))).code).toBe('NOT_FOUND');
  });
});

describe('reading the installation state', () => {
  it('is empty for a Secondary and 404 for another project', async () => {
    const state = await new GetInstallationUseCase(uow).execute(PROJECT, SECONDARY);
    expect(state).toMatchObject({ answers: [], marks: [] });
    expect(
      (await reason(new GetInstallationUseCase(uow).execute(OTHER_PROJECT, GENERAL))).code,
    ).toBe('NOT_FOUND');
  });
});
