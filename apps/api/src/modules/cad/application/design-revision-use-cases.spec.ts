import { Readable } from 'node:stream';
import {
  CadBuildRevisionJobSchema,
  CAD_STALE_AFTER_MINUTES,
  type CadMappingInput,
} from '@ftth/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../../common/app-error.js';
import type { IdGenerator } from '../../../common/clock.js';
import { InMemoryObjectStorage } from '../../../common/testing/in-memory-object-storage.js';
import type { CadFile } from '../domain/cad-file.js';
import {
  FakeClock,
  InMemoryCadUnitOfWork,
  RecordingJobQueue,
  type FakeLink,
} from '../testing/in-memory.js';
import { SaveCadMappingUseCase } from './cad-mapping.use-cases.js';
import { CreateDesignRevisionUseCase } from './create-design-revision.use-case.js';
import { DiscardDesignRevisionUseCase } from './discard-design-revision.use-case.js';
import { PublishDesignRevisionUseCase } from './publish-design-revision.use-case.js';
import { ReprocessCadFileUseCase } from './reprocess-cad-file.use-case.js';
import { ReviewTextLinkUseCase } from './review-text-link.use-case.js';
import {
  CreateTileUrlUseCase,
  GetRevisionTilesUseCase,
  VerifyTileRequestUseCase,
} from './tiles.use-cases.js';
import {
  ListDesignFeaturesUseCase,
  ListTextLinksUseCase,
} from './design-revision-queries.use-cases.js';
import type { DesignReadQueries } from '../domain/design-revision.repository.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT = '99999999-9999-4999-8999-999999999999';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const FILE = '33333333-3333-4333-8333-333333333333';
const SECRET = 'unit-test-tile-secret-unit-test-tile-secret';

let uow: InMemoryCadUnitOfWork;
let queue: RecordingJobQueue;
let clock: FakeClock;
let ids: IdGenerator;

const MAPPING: CadMappingInput = {
  rules: [{ source: 'layer', layer: 'N_DUC_CBL', target: 'route' }],
  crsEpsg: 32636,
  drawingUnit: 'in',
  version: null,
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
    storageKey: `projects/${PROJECT}/cad/${FILE}/original.dxf`,
    convertedStorageKey: null,
    status: 'processed',
    currentJobId: '44444444-4444-4444-8444-444444444444',
    converter: 'none',
    converterVersion: null,
    dxfVersion: 'AC1032',
    insUnits: 1,
    extents: null,
    crsDetection: {
      kind: 'projected_utm',
      reason: 'MATCHES_PROJECT_CRS',
      suggestedEpsg: 32636,
      projectEpsg: 32636,
      impliedUnit: 'm',
      insUnits: 1,
      declaredUnit: 'in',
      unitsConflict: true,
    },
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
  clock = new FakeClock(new Date('2026-10-28T10:00:00Z'));
  uow.files.rows.set(FILE, processedFile());
});

const save = (mapping: Partial<CadMappingInput> = {}, project = PROJECT) =>
  new SaveCadMappingUseCase(uow, clock).execute({
    projectId: project,
    cadFileId: FILE,
    actorId: ACTOR,
    mapping: { ...MAPPING, ...mapping },
  });

const create = (mappingVersion = 1, project = PROJECT) =>
  new CreateDesignRevisionUseCase(uow, queue, clock, ids).execute({
    projectId: project,
    actorId: ACTOR,
    request: { cadFileId: FILE, mappingVersion },
  });

/** Narrowing helper that fails the test with a clear message instead of a non-null assertion. */
function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('expected a value');
  return value;
}

const reason = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AppError);
  const appError = error as AppError;
  return { code: appError.code, status: appError.httpStatus, details: appError.details };
};

describe('SaveCadMappingUseCase', () => {
  it('inserts version 1 with the exact factor of the chosen unit and records the event', async () => {
    const saved = await save();
    expect(saved).toMatchObject({ version: 1, drawingUnit: 'in', metresPerUnit: '0.0254' });
    expect(uow.events.types()).toEqual(['cad_mapping.saved']);
    expect(uow.events.events[0]).toMatchObject({
      entity: 'cad_mapping',
      entityId: FILE,
      payload: { version: 1, crsEpsg: 32636, drawingUnit: 'in', ruleCount: 1 },
    });
  });

  it('bumps the version on update and refuses a stale or unexpected version', async () => {
    await save();
    expect((await save({ version: 1, drawingUnit: 'm' })).version).toBe(2);
    expect(await reason(save({ version: 1 }))).toMatchObject({
      code: 'CONFLICT',
      status: 409,
      details: { reason: 'VERSION_MISMATCH', currentVersion: 2 },
    });
    // A first save must not overwrite an existing mapping either.
    expect(await reason(save({ version: null }))).toMatchObject({
      details: { reason: 'VERSION_MISMATCH' },
    });
  });

  it('refuses a version when no mapping exists yet', async () => {
    expect(await reason(save({ version: 3 }))).toMatchObject({
      details: { reason: 'VERSION_MISMATCH', currentVersion: null },
    });
  });

  it('refuses a file that is not processed', async () => {
    uow.files.rows.set(FILE, processedFile({ status: 'processing' }));
    expect(await reason(save())).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'NOT_PROCESSED' },
    });
  });

  it("treats another project's file as not found", async () => {
    expect(await reason(save({}, OTHER_PROJECT))).toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(uow.mappings.rows.size).toBe(0);
  });
});

describe('CreateDesignRevisionUseCase', () => {
  it('freezes the mapping, queues the revision, records the event and pushes a valid job', async () => {
    await save();
    const revision = await create();

    expect(revision).toMatchObject({
      status: 'queued',
      cadFileId: FILE,
      mappingVersion: 1,
      crsEpsg: 32636,
      drawingUnit: 'in',
      metresPerUnit: '0.0254',
      insUnits: 1,
      unitsConflict: true,
      baseRevisionId: null,
      rules: MAPPING.rules,
    });
    expect(uow.events.types()).toEqual(['cad_mapping.saved', 'design_revision.queued']);
    expect(queue.buildJobs).toHaveLength(1);
    expect(CadBuildRevisionJobSchema.parse(queue.buildJobs[0])).toMatchObject({
      id: revision.currentJobId,
      type: 'cad.build_revision',
      revisionId: revision.id,
      projectId: PROJECT,
      cadFileId: FILE,
      attempt: 1,
    });
  });

  it('takes the latest published revision as the base', async () => {
    await save();
    const first = await create();
    uow.revisions.rows.set(first.id, { ...first, status: 'published', revNo: 1 });
    const second = await create();
    expect(second.baseRevisionId).toBe(first.id);
  });

  it('refuses without a mapping, with a stale mapping version and for an unprocessed file', async () => {
    expect(await reason(create())).toMatchObject({ details: { reason: 'NO_MAPPING' } });
    await save();
    expect(await reason(create(7))).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'MAPPING_VERSION_MISMATCH', currentVersion: 1 },
    });
    uow.files.rows.set(FILE, processedFile({ status: 'queued' }));
    expect(await reason(create())).toMatchObject({ details: { reason: 'NOT_PROCESSED' } });
  });

  it('allows only one open revision per project', async () => {
    await save();
    await create();
    expect(await reason(create())).toMatchObject({
      code: 'CONFLICT',
      status: 409,
      details: { reason: 'REVISION_IN_PROGRESS' },
    });
    expect(queue.buildJobs).toHaveLength(1);
  });

  it('marks the revision failed (ENQUEUE_FAILED) when the queue is down', async () => {
    await save();
    queue.failWith = new Error('redis down');
    const revision = await create();
    expect(revision).toMatchObject({ status: 'failed', errorCode: 'ENQUEUE_FAILED' });
    expect(uow.events.types()).toContain('design_revision.failed');
  });

  it("does not see another project's file", async () => {
    await save();
    expect(await reason(create(1, OTHER_PROJECT))).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('ReprocessCadFileUseCase revision guard', () => {
  const reprocess = () =>
    new ReprocessCadFileUseCase(uow, queue, clock, ids).execute({
      projectId: PROJECT,
      cadFileId: FILE,
      actorId: ACTOR,
    });

  it('refuses while a revision of the file is queued or building, and allows it afterwards', async () => {
    await save();
    const revision = await create();
    expect(await reason(reprocess())).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'REVISION_IN_PROGRESS' },
    });
    uow.revisions.rows.set(revision.id, { ...revision, status: 'building' });
    expect(await reason(reprocess())).toMatchObject({
      details: { reason: 'REVISION_IN_PROGRESS' },
    });
    uow.revisions.rows.set(revision.id, { ...revision, status: 'draft' });
    expect((await reprocess()).status).toBe('queued');
  });
});

describe('review, publish and discard', () => {
  const BOX_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const BOX_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const ROUTE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const LINK = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  let revisionId: string;

  const link = (overrides: Partial<FakeLink> = {}): FakeLink => ({
    id: LINK,
    projectId: PROJECT,
    revisionId,
    kind: 'box_id',
    status: 'review',
    featureId: BOX_A,
    text: '1-1',
    confidence: 0.4,
    distanceM: 3,
    reviewedById: null,
    ...overrides,
  });

  const review = (review: Parameters<ReviewTextLinkUseCase['execute']>[0]['review']) =>
    new ReviewTextLinkUseCase(uow, reads, clock).execute({
      projectId: PROJECT,
      revisionId,
      linkId: LINK,
      actorId: ACTOR,
      review,
    });
  const publish = (acknowledgeOpenItems = false) =>
    new PublishDesignRevisionUseCase(uow, clock).execute({
      projectId: PROJECT,
      revisionId,
      actorId: ACTOR,
      request: { acknowledgeOpenItems },
    });

  // The read side is SQL-only; for orchestration tests a stub that returns the stored link is enough.
  const reads = {
    textLink: async (_p: string, _r: string, linkId: string) => {
      const stored = uow.links.links.get(linkId);
      return stored ? ({ id: stored.id, status: stored.status } as never) : null;
    },
  } as unknown as DesignReadQueries;

  beforeEach(async () => {
    await save();
    const revision = await create();
    revisionId = revision.id;
    uow.revisions.rows.set(revisionId, { ...revision, status: 'draft' });
    uow.links.features.set(BOX_A, {
      id: BOX_A,
      projectId: PROJECT,
      revisionId,
      featureType: 'box',
      code: null,
    });
    uow.links.features.set(BOX_B, { ...must(uow.links.features.get(BOX_A)), id: BOX_B });
    uow.links.features.set(ROUTE, {
      ...must(uow.links.features.get(BOX_A)),
      id: ROUTE,
      featureType: 'route',
    });
    uow.links.links.set(LINK, link());
    uow.events.events.length = 0;
  });

  it('confirm keeps the proposed feature, recomputes the box code and counts, and records the event', async () => {
    await review({ action: 'confirm' });
    expect(uow.links.links.get(LINK)).toMatchObject({
      status: 'confirmed',
      featureId: BOX_A,
      confidence: 0.4,
      reviewedById: ACTOR,
    });
    expect(uow.links.features.get(BOX_A)?.code).toBe('1-1');
    expect(uow.links.counts).toMatchObject({ confirmed: 1, review: 0 });
    expect(uow.events.events).toHaveLength(1);
    expect(uow.events.events[0]).toMatchObject({
      type: 'text_link.reviewed',
      entityId: LINK,
      payload: {
        before: { status: 'review', featureId: BOX_A },
        after: { status: 'confirmed', featureId: BOX_A },
      },
    });
  });

  it('reassign moves the code from the old box to the new one', async () => {
    await review({ action: 'confirm' });
    await review({ action: 'confirm', featureId: BOX_B });
    expect(uow.links.features.get(BOX_A)?.code).toBeNull();
    expect(uow.links.features.get(BOX_B)?.code).toBe('1-1');
    expect(uow.links.links.get(LINK)?.featureId).toBe(BOX_B);
  });

  it('picks the best auto/confirmed link by confidence for the code', async () => {
    uow.links.links.set(
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      link({
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        status: 'auto',
        text: '2-2',
        confidence: 0.9,
      }),
    );
    await review({ action: 'confirm' });
    expect(uow.links.features.get(BOX_A)?.code).toBe('2-2');
  });

  it('reject keeps the proposed feature and drops the box code', async () => {
    uow.links.links.set(LINK, link({ status: 'auto' }));
    uow.links.features.set(BOX_A, { ...must(uow.links.features.get(BOX_A)), code: '1-1' });
    await review({ action: 'reject' });
    expect(uow.links.links.get(LINK)).toMatchObject({ status: 'rejected', featureId: BOX_A });
    expect(uow.links.features.get(BOX_A)?.code).toBeNull();
  });

  it('rejects a feature type the text kind does not allow with 422 FEATURE_TYPE_NOT_ALLOWED', async () => {
    expect(await reason(review({ action: 'confirm', featureId: ROUTE }))).toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      details: { reason: 'FEATURE_TYPE_NOT_ALLOWED', kind: 'box_id', featureType: 'route' },
    });
    expect(uow.links.links.get(LINK)?.status).toBe('review');
  });

  it('needs a feature when the link has none (422 FEATURE_REQUIRED)', async () => {
    uow.links.links.set(LINK, link({ featureId: null, distanceM: null }));
    expect(await reason(review({ action: 'confirm' }))).toMatchObject({
      status: 422,
      details: { reason: 'FEATURE_REQUIRED' },
    });
  });

  it('treats a feature of another revision or an unknown link as not found', async () => {
    const stranger = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    uow.links.features.set(stranger, {
      ...must(uow.links.features.get(BOX_A)),
      id: stranger,
      revisionId: '00000000-0000-4000-8000-0000000000aa',
    });
    expect(await reason(review({ action: 'confirm', featureId: stranger }))).toMatchObject({
      code: 'NOT_FOUND',
    });
    uow.links.links.clear();
    expect(await reason(review({ action: 'reject' }))).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('blocks publishing while items are open, until they are acknowledged', async () => {
    uow.links.diffConflicts = 2;
    expect(await reason(publish())).toMatchObject({
      code: 'CONFLICT',
      status: 409,
      details: { reason: 'OPEN_ITEMS', textLinksToReview: 1, diffConflicts: 2 },
    });
    const published = await publish(true);
    expect(published).toMatchObject({ status: 'published', revNo: 1, publishedById: ACTOR });
    expect(uow.events.types()).toEqual(['design_revision.published']);
    expect(uow.events.events[0]?.payload).toMatchObject({ revNo: 1, acknowledgedOpenItems: true });
  });

  it('publishes without acknowledgement when nothing is open and numbers revisions per project', async () => {
    await review({ action: 'confirm' });
    expect((await publish()).revNo).toBe(1);
    expect(await reason(publish())).toMatchObject({ details: { reason: 'NOT_DRAFT' } });
    expect(await reason(review({ action: 'reject' }))).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'REVISION_LOCKED' },
    });

    const next = await create();
    uow.revisions.rows.set(next.id, { ...next, status: 'draft' });
    const second = await new PublishDesignRevisionUseCase(uow, clock).execute({
      projectId: PROJECT,
      revisionId: next.id,
      actorId: ACTOR,
      request: { acknowledgeOpenItems: false },
    });
    expect(second.revNo).toBe(2);
  });

  describe('discard', () => {
    const discard = () =>
      new DiscardDesignRevisionUseCase(uow, clock, ids).execute({
        projectId: PROJECT,
        revisionId,
        actorId: ACTOR,
      });
    const setStatus = (status: 'queued' | 'building' | 'published' | 'failed') => {
      const row = must(uow.revisions.rows.get(revisionId));
      uow.revisions.rows.set(revisionId, {
        ...row,
        status,
        errorCode: status === 'failed' ? 'TILES_FAILED' : null,
      });
    };

    it('discards a draft, supersedes its job and records the event', async () => {
      const before = must(uow.revisions.rows.get(revisionId)).currentJobId;
      const discarded = await discard();
      expect(discarded.status).toBe('discarded');
      expect(discarded.currentJobId).not.toBe(before);
      expect(uow.events.types()).toEqual(['design_revision.discarded']);
    });

    it('discards a failed revision and keeps its error code in the event only', async () => {
      setStatus('failed');
      const discarded = await discard();
      expect(discarded).toMatchObject({ status: 'discarded', errorCode: null });
      expect(uow.events.events[0]?.payload).toMatchObject({
        previousStatus: 'failed',
        errorCode: 'TILES_FAILED',
      });
    });

    it('discards queued/building revisions only once they are stale', async () => {
      setStatus('queued');
      expect(await reason(discard())).toMatchObject({ details: { reason: 'NOT_DISCARDABLE' } });
      clock.advanceMinutes(CAD_STALE_AFTER_MINUTES + 1);
      expect((await discard()).status).toBe('discarded');
    });

    it('never discards a published revision', async () => {
      setStatus('published');
      expect(await reason(discard())).toMatchObject({
        code: 'CONFLICT',
        details: { reason: 'NOT_DISCARDABLE' },
      });
    });
  });

  describe('lists', () => {
    const emptyReads = {
      features: async () => ({ items: [{}], page: 1, pageSize: 100, total: 1 }),
      textLinks: async () => ({ items: [{}], page: 1, pageSize: 100, total: 1 }),
    } as unknown as DesignReadQueries;

    it('are empty until the build has finished', async () => {
      const row = must(uow.revisions.rows.get(revisionId));
      const features = new ListDesignFeaturesUseCase(uow.revisions, emptyReads);
      const links = new ListTextLinksUseCase(uow.revisions, emptyReads);
      const query = { page: 1, pageSize: 100 };

      expect((await features.execute(PROJECT, revisionId, query)).total).toBe(1);
      uow.revisions.rows.set(revisionId, { ...row, status: 'building' });
      expect((await features.execute(PROJECT, revisionId, query)).items).toEqual([]);
      expect((await links.execute(PROJECT, revisionId, query)).items).toEqual([]);
      expect(await reason(features.execute(OTHER_PROJECT, revisionId, query))).toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });
});

describe('tile use cases', () => {
  const NOW_SECONDS = () => Math.floor(clock.now().getTime() / 1000);
  let revisionId: string;
  const config = { secret: SECRET, publicUrl: 'https://tiles.example.test' };

  beforeEach(async () => {
    await save();
    const revision = await create();
    revisionId = revision.id;
  });

  const makeUrl = (cfg: typeof config | null = config) =>
    new CreateTileUrlUseCase(uow.revisions, cfg, clock).execute(PROJECT, revisionId);
  const setStatus = (status: 'draft' | 'published' | 'failed') =>
    uow.revisions.rows.set(revisionId, { ...must(uow.revisions.rows.get(revisionId)), status });

  it('signs a one-hour URL template that the verifier accepts', async () => {
    setStatus('draft');
    const { urlTemplate, expiresAt } = await makeUrl();
    expect(urlTemplate).toMatch(
      new RegExp(
        `^https://tiles\\.example\\.test/design_features/\\{z\\}/\\{x\\}/\\{y\\}\\?p=${PROJECT}&r=${revisionId}&exp=\\d+&sig=[A-Za-z0-9_-]{43}$`,
      ),
    );
    expect(new Date(expiresAt).getTime() / 1000).toBe(NOW_SECONDS() + 3600);

    const verify = new VerifyTileRequestUseCase(config, clock);
    const concrete = new URL(urlTemplate.replace('{z}/{x}/{y}', '14/9640/6290'));
    expect(verify.execute(concrete.pathname + concrete.search)).toBe(true);

    clock.advanceMinutes(61);
    expect(verify.execute(concrete.pathname + concrete.search)).toBe(false);
  });

  it('answers 404 when tiles are not configured or the revision is not draft/published', async () => {
    setStatus('draft');
    expect(await reason(makeUrl(null))).toMatchObject({ code: 'NOT_FOUND', status: 404 });
    setStatus('failed');
    expect(await reason(makeUrl())).toMatchObject({ code: 'NOT_FOUND' });
    setStatus('published');
    expect((await makeUrl()).urlTemplate).toContain('/design_features/');
    expect(
      await reason(
        new CreateTileUrlUseCase(uow.revisions, config, clock).execute(OTHER_PROJECT, revisionId),
      ),
    ).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('verifies nothing when unconfigured or when the header is absent', () => {
    expect(new VerifyTileRequestUseCase(null, clock).execute('/design_features/1/1/1?p=a')).toBe(
      false,
    );
    expect(new VerifyTileRequestUseCase(config, clock).execute(undefined)).toBe(false);
  });

  describe('PMTiles download', () => {
    const KEY = 'projects/p/revisions/r/design.pmtiles';
    let storage: InMemoryObjectStorage;
    const body = Buffer.from('0123456789');

    beforeEach(async () => {
      storage = new InMemoryObjectStorage();
      await storage.put(KEY, Readable.from([body]), { contentType: 'x', maxBytes: 100 });
    });
    const download = (range?: string, project = PROJECT) =>
      new GetRevisionTilesUseCase(uow.revisions, storage).execute(project, revisionId, range);
    const read = async (stream: Readable) => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString();
    };

    it('is 404 while the revision has no archive or the object is missing', async () => {
      expect(await reason(download())).toMatchObject({ code: 'NOT_FOUND' });
      uow.revisions.rows.set(revisionId, {
        ...must(uow.revisions.rows.get(revisionId)),
        tilesStorageKey: 'projects/p/revisions/r/missing.pmtiles',
      });
      expect(await reason(download())).toMatchObject({ code: 'NOT_FOUND' });
    });

    it('streams the whole archive, one range, or reports an unsatisfiable range', async () => {
      uow.revisions.rows.set(revisionId, {
        ...must(uow.revisions.rows.get(revisionId)),
        status: 'draft',
        tilesStorageKey: KEY,
      });
      const full = await download();
      expect(full).toMatchObject({ kind: 'stream', sizeBytes: 10, range: null });
      if (full.kind === 'stream') expect(await read(full.stream)).toBe('0123456789');

      const part = await download('bytes=2-4');
      expect(part).toMatchObject({ kind: 'stream', sizeBytes: 10, range: { start: 2, end: 4 } });
      if (part.kind === 'stream') expect(await read(part.stream)).toBe('234');

      expect(await download('bytes=50-')).toEqual({ kind: 'unsatisfiable', sizeBytes: 10 });
      expect(await reason(download(undefined, OTHER_PROJECT))).toMatchObject({ code: 'NOT_FOUND' });
    });

    it('serves only draft and published revisions, like the tile URL (security review L4)', async () => {
      for (const status of ['discarded', 'failed', 'building'] as const) {
        uow.revisions.rows.set(revisionId, {
          ...must(uow.revisions.rows.get(revisionId)),
          status,
          tilesStorageKey: KEY,
        });
        expect(await reason(download())).toMatchObject({ code: 'NOT_FOUND' });
      }
    });
  });
});
