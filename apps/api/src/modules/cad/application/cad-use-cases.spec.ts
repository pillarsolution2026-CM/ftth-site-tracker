import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { CadImportJobSchema, CAD_STALE_AFTER_MINUTES, type DrawingKind } from '@ftth/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdGenerator } from '../../../common/clock.js';
import { InMemoryObjectStorage } from '../../../common/testing/in-memory-object-storage.js';
import {
  FakeClock,
  InMemoryCadUnitOfWork,
  InMemoryWorkOrderSites,
  RecordingJobQueue,
} from '../testing/in-memory.js';
import type { SiteDrawingRecord } from '../domain/site-drawing.js';
import { ReprocessCadFileUseCase } from './reprocess-cad-file.use-case.js';
import { UploadCadFileUseCase } from './upload-cad-file.use-case.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT = '99999999-9999-4999-8999-999999999999';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const SITE = 'abababab-abab-4bab-8bab-abababababab';
const OTHER_SITE = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
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
  const sites = new InMemoryWorkOrderSites();
  sites.sites = [SITE, OTHER_SITE].map((id, index) => ({
    id,
    workOrderId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    name: `site ${index + 1}`,
    position: index + 1,
  }));
  upload = new UploadCadFileUseCase(uow, storage, queue, clock, ids, 1024, sites);
  reprocess = new ReprocessCadFileUseCase(uow, queue, clock, ids);
});

const send = (
  fileName: string,
  content: string | Buffer,
  options: {
    kind?: DrawingKind;
    siteId?: string;
    target?: 'new_drawing' | 'new_version';
    drawingId?: string;
  } = {},
) =>
  upload.execute({
    projectId: PROJECT,
    actorId: ACTOR,
    file: { fileName, stream: Readable.from([Buffer.from(content)]) },
    siteId: options.siteId ?? SITE,
    kind: options.kind ?? 'general',
    target: options.target ?? 'new_drawing',
    drawingId: options.drawingId,
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
    expect(uow.events.types()).toEqual([
      'site_drawing.created',
      'cad_file.uploaded',
      'cad_file.queued',
    ]);
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
    expect(uow.events.types()).toEqual([
      'site_drawing.created',
      'cad_file.uploaded',
      'cad_file.queued',
      'cad_file.failed',
    ]);
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

  describe('drawings of a site (ADR-049 part B)', () => {
    /** A new drawing of a site, then a new version of it. */
    const version = (drawingId: string, options: { kind?: DrawingKind; siteId?: string } = {}) =>
      send('v.dxf', DXF, { ...options, target: 'new_version', drawingId });

    it('stores the kind, opens a drawing in the site and records both on the events', async () => {
      const file = await send('sec.dxf', DXF, { kind: 'secondary' });
      expect(file).toMatchObject({
        drawingKind: 'secondary',
        siteId: SITE,
        drawingOrdinal: 1,
        supersededAt: null,
      });
      expect(uow.drawings.rows.get(file.drawingId)).toMatchObject({
        siteId: SITE,
        kind: 'secondary',
        ordinal: 1,
      });
      expect(uow.events.types()).toEqual([
        'site_drawing.created',
        'cad_file.uploaded',
        'cad_file.queued',
      ]);
      expect(uow.events.events[1]?.payload).toMatchObject({
        drawingKind: 'secondary',
        drawingId: file.drawingId,
        siteId: SITE,
        supersededFileIds: [],
      });
    });

    it('refuses a second General in the site with GENERAL_EXISTS and stores nothing for it', async () => {
      const first = await send('a.dxf', DXF);
      await expect(send('b.dxf', DXF)).rejects.toMatchObject({
        code: 'CONFLICT',
        details: {
          reason: 'GENERAL_EXISTS',
          siteId: SITE,
          drawingId: first.drawingId,
          currentFileName: 'a.dxf',
        },
      });
      expect(storage.objects.size).toBe(1);
      expect(uow.files.rows.size).toBe(1);
    });

    it('does not store the file when the General already exists (pre-check before storage)', async () => {
      await send('a.dxf', DXF);
      const put = vi.spyOn(storage, 'put');
      await expect(send('b.dxf', DXF)).rejects.toMatchObject({
        details: { reason: 'GENERAL_EXISTS' },
      });
      expect(put).not.toHaveBeenCalled();
    });

    it('always allows another Secondary, numbered after the last', async () => {
      const one = await send('s1.dxf', DXF, { kind: 'secondary' });
      const two = await send('s2.dxf', DXF, { kind: 'secondary' });
      expect([one.drawingOrdinal, two.drawingOrdinal]).toEqual([1, 2]);
      expect(one.drawingId).not.toBe(two.drawingId);
      expect(uow.files.rows.get(one.id)?.supersededAt).toBeNull();
    });

    it('lets the General and the Secondary of a site be separate drawings', async () => {
      const general = await send('g.dxf', DXF, { kind: 'general' });
      const secondary = await send('s.dxf', DXF, { kind: 'secondary' });
      expect(general.drawingId).not.toBe(secondary.drawingId);
      expect(uow.files.rows.size).toBe(2);
    });

    it("supersedes the drawing's current file with a new version and keeps it as history", async () => {
      const first = await send('a.dxf', DXF);
      clock.advanceMinutes(1);
      const second = await version(first.drawingId);

      expect(second.drawingId).toBe(first.drawingId);
      expect(uow.files.rows.get(first.id)).toMatchObject({
        supersededAt: clock.now(),
        supersededById: second.id,
      });
      expect(second.supersededAt).toBeNull();
      const uploaded = uow.events.events.filter((e) => e.type === 'cad_file.uploaded');
      expect(uploaded[1]?.payload).toMatchObject({ supersededFileIds: [first.id] });
      // No second drawing was opened.
      expect(uow.events.types().filter((t) => t === 'site_drawing.created')).toHaveLength(1);
    });

    it('refuses a new version of a drawing of another site or kind, or of an unknown drawing', async () => {
      const general = await send('a.dxf', DXF);
      await expect(version(general.drawingId, { siteId: OTHER_SITE })).rejects.toMatchObject({
        details: { reason: 'DRAWING_NOT_IN_SITE' },
      });
      await expect(version(general.drawingId, { kind: 'secondary' })).rejects.toMatchObject({
        details: { reason: 'DRAWING_NOT_IN_SITE' },
      });
      await expect(version('99999999-9999-4999-8999-999999999999')).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('refuses an unassigned drawing: it takes no upload until linked', async () => {
      const general = await send('a.dxf', DXF);
        ...(uow.drawings.rows.get(general.drawingId) as SiteDrawingRecord),
        ...(uow.drawings.rows.get(general.drawingId) as never),
        siteId: null,
      });
      await expect(version(general.drawingId)).rejects.toMatchObject({
        details: { reason: 'DRAWING_UNASSIGNED' },
      });
    });

    it('refuses a site that is not on the work order of the project', async () => {
      await expect(
        send('a.dxf', DXF, { siteId: '99999999-9999-4999-8999-999999999999' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', details: { reason: 'SITE_NOT_FOUND' } });
      expect(storage.objects.size).toBe(0);
    });

    it.each(['queued', 'building', 'draft'] as const)(
      'discards the open %s revision of the drawing on a new version, with a new job id, and no other',
      async (status) => {
        const first = await send('a.dxf', DXF);
        const sec = await send('s.dxf', DXF, { kind: 'secondary' });
        const revision = (id: string, file: { id: string; drawingId: string }, kind: DrawingKind) =>
          ({
            id,
            projectId: PROJECT,
            cadFileId: file.id,
            drawingId: file.drawingId,
            drawingKind: kind,
            status,
            currentJobId: 'job-old',
            errorCode: null,
          }) as never;
        uow.revisions.rows.set('rev-g', revision('rev-g', first, 'general'));
        uow.revisions.rows.set('rev-s', revision('rev-s', sec, 'secondary'));
        uow.events.events.length = 0;

        const next = await version(first.drawingId);

        expect(uow.revisions.rows.get('rev-g')).toMatchObject({ status: 'discarded' });
        expect(uow.revisions.rows.get('rev-g')?.currentJobId).not.toBe('job-old');
        expect(uow.revisions.rows.get('rev-s')).toMatchObject({ status, currentJobId: 'job-old' });
        const uploaded = uow.events.events.find(
          (e) => e.type === 'cad_file.uploaded' && e.entityId === next.id,
        );
        expect(uploaded?.payload).toMatchObject({ discardedRevisionId: 'rev-g' });
        expect(uow.events.types()).toContain('design_revision.discarded');
      },
    );

    it('records a null discardedRevisionId when no revision is open', async () => {
      const first = await send('a.dxf', DXF);
      await version(first.drawingId);
      const uploaded = uow.events.events.filter((e) => e.type === 'cad_file.uploaded');
      expect(uploaded[1]?.payload).toMatchObject({ discardedRevisionId: null });
    });
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
