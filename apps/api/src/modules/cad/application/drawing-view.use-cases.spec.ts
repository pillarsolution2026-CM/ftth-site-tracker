import { Readable } from 'node:stream';
import { CadRenderViewJobSchema, DrawingViewStateSchema } from '@ftth/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import type { IdGenerator } from '../../../common/clock.js';
import { InMemoryObjectStorage } from '../../../common/testing/in-memory-object-storage.js';
import type { CadFile } from '../domain/cad-file.js';
import { FakeClock, InMemoryCadUnitOfWork, RecordingJobQueue } from '../testing/in-memory.js';
import {
  GetDrawingViewContentUseCase,
  GetDrawingViewStateUseCase,
  RequestDrawingViewUseCase,
} from './drawing-view.use-cases.js';
import { ReprocessCadFileUseCase } from './reprocess-cad-file.use-case.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT = '99999999-9999-4999-8999-999999999999';
const FILE = '33333333-3333-4333-8333-333333333333';
const ACTOR = '22222222-2222-4222-8222-222222222222';

let uow: InMemoryCadUnitOfWork;
let queue: RecordingJobQueue;
let clock: FakeClock;
let ids: IdGenerator;
let storage: InMemoryObjectStorage;
let request: RequestDrawingViewUseCase;
let state: GetDrawingViewStateUseCase;
let content: GetDrawingViewContentUseCase;

function file(overrides: Partial<CadFile> = {}): CadFile {
  const now = clock.now();
  return {
    id: FILE,
    projectId: PROJECT,
    originalName: 'plan.dxf',
    format: 'dxf',
    sizeBytes: 10,
    sha256: 'a'.repeat(64),
    storageKey: `projects/${PROJECT}/cad/${FILE}/original.dxf`,
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
  storage = new InMemoryObjectStorage();
  clock = new FakeClock(new Date('2026-11-09T10:00:00Z'));
  uow.files.rows.set(FILE, file());
  request = new RequestDrawingViewUseCase(uow, queue, clock, ids);
  state = new GetDrawingViewStateUseCase(uow);
  content = new GetDrawingViewContentUseCase(uow, storage);
});

const readyView = () =>
  uow.files.views.set(FILE, {
    cadFileId: FILE,
    status: 'ready',
    jobId: '55555555-5555-4555-8555-555555555555',
    storageKey: `projects/${PROJECT}/cad/${FILE}/view.json.gz`,
    sizeBytes: 4,
    errorCode: null,
    renderedAt: clock.now(),
  });

describe('GetDrawingViewStateUseCase', () => {
  it('reports none for a file without a view, in the contract shape', async () => {
    const result = await state.execute(PROJECT, FILE);
    expect(DrawingViewStateSchema.parse(result)).toEqual({
      cadFileId: FILE,
      status: 'none',
      errorCode: null,
      sizeBytes: null,
      renderedAt: null,
    });
  });

  it('is not found in another project', async () => {
    await expect(state.execute(OTHER_PROJECT, FILE)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('RequestDrawingViewUseCase', () => {
  it('queues a render job for a processed file without a view', async () => {
    const result = await request.execute(PROJECT, FILE);

    expect(result.status).toBe('queued');
    expect(queue.viewJobs).toHaveLength(1);
    const job = CadRenderViewJobSchema.parse(queue.viewJobs[0]);
    expect(job).toMatchObject({ cadFileId: FILE, projectId: PROJECT, attempt: 1 });
    expect(uow.files.views.get(FILE)?.jobId).toBe(job.id);
  });

  it('queues again after a failure, with a new job id', async () => {
    uow.files.views.set(FILE, {
      cadFileId: FILE,
      status: 'failed',
      jobId: '55555555-5555-4555-8555-555555555555',
      storageKey: null,
      sizeBytes: null,
      errorCode: 'RENDER_FAILED',
      renderedAt: null,
    });
    const result = await request.execute(PROJECT, FILE);

    expect(result).toMatchObject({ status: 'queued', errorCode: null });
    expect(queue.viewJobs).toHaveLength(1);
    expect(queue.viewJobs[0]?.id).not.toBe('55555555-5555-4555-8555-555555555555');
  });

  it('is idempotent while queued: no second job', async () => {
    await request.execute(PROJECT, FILE);
    const again = await request.execute(PROJECT, FILE);
    expect(again.status).toBe('queued');
    expect(queue.viewJobs).toHaveLength(1);
  });

  it('is idempotent when ready: state returned, no job', async () => {
    readyView();
    const result = await request.execute(PROJECT, FILE);
    expect(result).toMatchObject({ status: 'ready', sizeBytes: 4 });
    expect(queue.viewJobs).toEqual([]);
  });

  it.each(['uploaded', 'queued', 'processing', 'failed'] as const)(
    'refuses a %s file with NOT_PROCESSED',
    async (status) => {
      uow.files.rows.set(FILE, file({ status }));
      await expect(request.execute(PROJECT, FILE)).rejects.toMatchObject({
        code: 'CONFLICT',
        details: { reason: 'NOT_PROCESSED' },
      });
      expect(queue.viewJobs).toEqual([]);
    },
  );

  it('is not found in another project and queues nothing', async () => {
    await expect(request.execute(OTHER_PROJECT, FILE)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(queue.viewJobs).toEqual([]);
  });

  it('marks the view failed with QUEUE_UNAVAILABLE when the queue is down, and can be retried', async () => {
    queue.failWith = new Error('redis unavailable');
    const result = await request.execute(PROJECT, FILE);
    expect(result).toMatchObject({ status: 'failed', errorCode: 'QUEUE_UNAVAILABLE' });

    queue.failWith = null;
    const retried = await request.execute(PROJECT, FILE);
    expect(retried.status).toBe('queued');
    expect(queue.viewJobs).toHaveLength(1);
  });
});

describe('GetDrawingViewContentUseCase', () => {
  it('is not found before the view is ready', async () => {
    await expect(content.execute(PROJECT, FILE)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await request.execute(PROJECT, FILE);
    await expect(content.execute(PROJECT, FILE)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('streams the stored bytes when ready', async () => {
    readyView();
    await storage.put(
      `projects/${PROJECT}/cad/${FILE}/view.json.gz`,
      Readable.from([Buffer.from('gzip')]),
      { contentType: 'application/gzip', maxBytes: 100 },
    );
    const result = await content.execute(PROJECT, FILE);
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) chunks.push(Buffer.from(chunk as Buffer));
    expect(Buffer.concat(chunks).toString()).toBe('gzip');
    expect(result.sizeBytes).toBe(4);
  });

  it('is not found in another project', async () => {
    readyView();
    await expect(content.execute(OTHER_PROJECT, FILE)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('reprocessing', () => {
  it('resets the view to none', async () => {
    readyView();
    await new ReprocessCadFileUseCase(uow, queue, clock, ids).execute({
      projectId: PROJECT,
      cadFileId: FILE,
      actorId: ACTOR,
    });
    expect(await state.execute(PROJECT, FILE)).toMatchObject({ status: 'none', sizeBytes: null });
  });
});
