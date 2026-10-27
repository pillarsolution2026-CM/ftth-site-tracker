import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { CadImportJobSchema, CAD_STALE_AFTER_MINUTES } from '@ftth/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import type { IdGenerator } from '../../../common/clock.js';
import { InMemoryObjectStorage } from '../../../common/testing/in-memory-object-storage.js';
import { FakeClock, InMemoryCadUnitOfWork, RecordingJobQueue } from '../testing/in-memory.js';
import { ReprocessCadFileUseCase } from './reprocess-cad-file.use-case.js';
import { UploadCadFileUseCase } from './upload-cad-file.use-case.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT = '99999999-9999-4999-8999-999999999999';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const DXF = '  0\nSECTION\n  2\nHEADER\n  0\nENDSEC\n  0\nEOF\n';

let uow: InMemoryCadUnitOfWork;
let storage: InMemoryObjectStorage;
let queue: RecordingJobQueue;
let clock: FakeClock;
let upload: UploadCadFileUseCase;
let reprocess: ReprocessCadFileUseCase;

beforeEach(() => {
  let n = 0;
  const ids: IdGenerator = {
    next: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  };
  uow = new InMemoryCadUnitOfWork();
  storage = new InMemoryObjectStorage();
  queue = new RecordingJobQueue();
  clock = new FakeClock(new Date('2026-10-27T10:00:00Z'));
  upload = new UploadCadFileUseCase(uow, storage, queue, clock, ids, 1024);
  reprocess = new ReprocessCadFileUseCase(uow, queue, clock, ids);
});

const send = (fileName: string, content: string | Buffer) =>
  upload.execute({
    projectId: PROJECT,
    actorId: ACTOR,
    file: { fileName, stream: Readable.from([Buffer.from(content)]) },
  });

describe('UploadCadFileUseCase', () => {
  it('stores the original, queues the file, records both events and pushes one valid job', async () => {
    const file = await send('plan.dxf', DXF);

    expect(file).toMatchObject({
      status: 'queued',
      format: 'dxf',
      originalName: 'plan.dxf',
      sizeBytes: DXF.length,
      sha256: createHash('sha256').update(DXF).digest('hex'),
      uploadedById: ACTOR,
    });
    expect(storage.objects.get(file.storageKey)?.toString()).toBe(DXF);
    expect(file.storageKey).toBe(`projects/${PROJECT}/cad/${file.id}/original.dxf`);
    expect(uow.events.types()).toEqual(['cad_file.uploaded', 'cad_file.queued']);
    expect(uow.events.events.every((e) => e.actorId === ACTOR && e.projectId === PROJECT)).toBe(
      true,
    );

    expect(queue.jobs).toHaveLength(1);
    const job = CadImportJobSchema.parse(queue.jobs[0]);
    expect(job).toMatchObject({
      id: file.currentJobId,
      cadFileId: file.id,
      projectId: PROJECT,
      storageKey: file.storageKey,
      format: 'dxf',
      attempt: 1,
    });
  });

  it('accepts a DWG by its AC10xx signature', async () => {
    const file = await send('plan.dwg', Buffer.concat([Buffer.from('AC1032'), Buffer.alloc(100)]));
    expect(file.format).toBe('dwg');
    expect(file.storageKey.endsWith('/original.dwg')).toBe(true);
  });

  it.each([
    ['plan.dwg', DXF, 'DXF content named .dwg'],
    ['plan.dxf', 'AC1032xxxx', 'DWG content named .dxf'],
    ['plan.dxf', '%PDF-1.7 hello', 'PDF content named .dxf'],
    ['plan.pdf', DXF, 'a .pdf name'],
    ['plan.dxf', '', 'an empty file'],
  ])('refuses %s (%s) and stores nothing', async (name, content) => {
    await expect(send(name, content)).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' });
    expect(storage.objects.size).toBe(0);
    expect(uow.files.rows.size).toBe(0);
    expect(queue.jobs).toEqual([]);
  });

  it('refuses a file above the size limit with FILE_TOO_LARGE and keeps nothing', async () => {
    await expect(send('big.dxf', DXF + 'x'.repeat(2000))).rejects.toMatchObject({
      code: 'FILE_TOO_LARGE',
    });
    expect(storage.objects.size).toBe(0);
    expect(uow.files.rows.size).toBe(0);
  });

  it('marks the file failed with ENQUEUE_FAILED when the queue is down, and says so in an event', async () => {
    queue.failWith = new Error('redis unavailable');
    const file = await send('plan.dxf', DXF);

    expect(file).toMatchObject({ status: 'failed', errorCode: 'ENQUEUE_FAILED' });
    expect(uow.events.types()).toEqual(['cad_file.uploaded', 'cad_file.queued', 'cad_file.failed']);
    expect(storage.objects.size).toBe(1); // the original is kept so it can be reprocessed

    queue.failWith = null;
    const retried = await reprocess.execute({
      projectId: PROJECT,
      cadFileId: file.id,
      actorId: ACTOR,
    });
    expect(retried).toMatchObject({ status: 'queued', errorCode: null, errorMessage: null });
    expect(retried.currentJobId).not.toBe(file.currentJobId);
    expect(queue.jobs).toHaveLength(1);
  });
});

describe('ReprocessCadFileUseCase', () => {
  it('queues a processed file again with a new job id', async () => {
    const file = await send('plan.dxf', DXF);
    uow.files.rows.set(file.id, { ...file, status: 'processed', processedAt: clock.now() });

    const again = await reprocess.execute({
      projectId: PROJECT,
      cadFileId: file.id,
      actorId: ACTOR,
    });

    expect(again.status).toBe('queued');
    expect(queue.jobs.map((job) => job.id)).toEqual([file.currentJobId, again.currentJobId]);
    expect(queue.jobs[0]?.id).not.toBe(queue.jobs[1]?.id);
    expect(uow.events.types().slice(-1)).toEqual(['cad_file.queued']);
    expect(uow.events.events.at(-1)?.payload).toMatchObject({
      reprocess: true,
      previousStatus: 'processed',
    });
  });

  it('refuses while a recent job is queued or processing', async () => {
    const file = await send('plan.dxf', DXF);
    await expect(
      reprocess.execute({ projectId: PROJECT, cadFileId: file.id, actorId: ACTOR }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    uow.files.rows.set(file.id, {
      ...file,
      status: 'processing',
      processingStartedAt: clock.now(),
    });
    clock.advanceMinutes(CAD_STALE_AFTER_MINUTES - 1);
    await expect(
      reprocess.execute({ projectId: PROJECT, cadFileId: file.id, actorId: ACTOR }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(queue.jobs).toHaveLength(1);
  });

  it('allows it once the job is stale', async () => {
    const file = await send('plan.dxf', DXF);
    clock.advanceMinutes(CAD_STALE_AFTER_MINUTES + 1);
    const again = await reprocess.execute({
      projectId: PROJECT,
      cadFileId: file.id,
      actorId: ACTOR,
    });
    expect(again.status).toBe('queued');
    expect(again.currentJobId).not.toBe(file.currentJobId);
  });

  it('does not find a file of another project', async () => {
    const file = await send('plan.dxf', DXF);
    await expect(
      reprocess.execute({ projectId: OTHER_PROJECT, cadFileId: file.id, actorId: ACTOR }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
