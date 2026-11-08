import { MAX_CONTROL_POINTS, type ControlPoint } from '@ftth/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../../common/app-error.js';
import type { CadFile } from '../domain/cad-file.js';
import type { CadMappingRecord } from '../domain/cad-mapping.js';
import type { GpsProposalRecord } from '../domain/gps-proposal.js';
import { FakeClock, InMemoryCadUnitOfWork } from '../testing/in-memory.js';
import { AcceptGpsProposalUseCase, RejectGpsProposalUseCase } from './gps-proposal.use-cases.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PROJECT = id(1);
const FILE = id(2);
const PM = id(3);

const proposal = (n: number, overrides: Partial<GpsProposalRecord> = {}): GpsProposalRecord => ({
  id: id(100 + n),
  projectId: PROJECT,
  designRevisionId: id(4),
  revNo: 1,
  cadFileId: FILE,
  featureId: id(5),
  featureType: 'box',
  code: '1-1',
  handle: 'B1',
  lat: 30.1,
  lon: 31.2,
  accuracyM: 3,
  fixAt: new Date('2026-11-08T10:00:00Z'),
  receivedAt: new Date('2026-11-08T10:00:01Z'),
  proposedBy: { id: id(6), name: 'Supervisor' },
  note: null,
  photo: null,
  status: 'pending',
  decidedBy: null,
  decidedAt: null,
  rejectReason: null,
  acceptedMappingVersion: null,
  ...overrides,
});

const typedPoint = (pointId: string, handle: string | null): ControlPoint => ({
  id: pointId,
  drawing: { x: 1, y: 2 },
  handle,
  label: null,
  lat: 30,
  lon: 31,
  source: 'typed',
  excluded: false,
});

const mappingRecord = (overrides: Partial<CadMappingRecord> = {}): CadMappingRecord => ({
  cadFileId: FILE,
  projectId: PROJECT,
  rules: [{ source: 'layer', layer: 'sub', target: 'box' }],
  crsEpsg: 32636,
  drawingUnit: 'm',
  metresPerUnit: '1',
  placement: null,
  version: 1,
  updatedById: null,
  updatedAt: new Date(0),
  ...overrides,
});

let uow: InMemoryCadUnitOfWork;
let clock: FakeClock;

beforeEach(() => {
  uow = new InMemoryCadUnitOfWork();
  clock = new FakeClock(new Date('2026-11-08T12:00:00Z'));
  uow.mappings.rows.set(FILE, mappingRecord());
  // Only the fields the accept use case reads; the rest of a file row is irrelevant here.
  uow.files.rows.set(FILE, { id: FILE, projectId: PROJECT, status: 'processed' } as CadFile);
  uow.proposals.centres.set(id(5), { x: 100, y: 200 });
});

const seed = (record: GpsProposalRecord) => uow.proposals.rows.set(record.id, record);
const accept = (proposalId: string, mappingVersion: number, projectId = PROJECT) =>
  new AcceptGpsProposalUseCase(uow, clock).execute({
    projectId,
    proposalId,
    actorId: PM,
    mappingVersion,
  });
const reasonOf = async (promise: Promise<unknown>): Promise<unknown> => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AppError);
  return (error as AppError).details;
};

describe('AcceptGpsProposalUseCase', () => {
  it('creates a placement with defaults when there is none, and saves a new version', async () => {
    const p = proposal(1);
    seed(p);
    const decided = await accept(p.id, 1);
    expect(decided).toMatchObject({ status: 'accepted', acceptedMappingVersion: 2 });
    const mapping = uow.mappings.rows.get(FILE);
    expect(mapping?.version).toBe(2);
    expect(mapping?.placement).toMatchObject({
      sourceCrs: 'project',
      fitScaleWithTwoPoints: false,
      adjust: { dx: 0, dy: 0, rotationDeg: 0, scale: 1, pivot: null },
    });
    expect(mapping?.placement?.points).toEqual([
      {
        id: p.id,
        drawing: { x: 100, y: 200 },
        handle: 'B1',
        label: '1-1',
        lat: 30.1,
        lon: 31.2,
        source: 'gps',
        excluded: false,
      },
    ]);
    expect(mapping?.updatedById).toBe(PM);
    expect(uow.events.types()).toEqual(['cad_mapping.saved', 'gps_proposal.accepted']);
  });

  it('labels the point with the handle when the item has no code', async () => {
    const p = proposal(1, { code: null });
    seed(p);
    await accept(p.id, 1);
    expect(uow.mappings.rows.get(FILE)?.placement?.points[0]?.label).toBe('B1');
  });

  it('replaces earlier gps points of the same handle and keeps typed and other points', async () => {
    const earlier = { ...typedPoint('g-old', 'B1'), source: 'gps' as const };
    const otherGps = { ...typedPoint('g-other', 'B2'), source: 'gps' as const };
    uow.mappings.rows.set(
      FILE,
      mappingRecord({
        version: 4,
        placement: {
          sourceCrs: 'egypt_red_belt',
          fitScaleWithTwoPoints: true,
          adjust: { dx: 1, dy: 2, rotationDeg: 0, scale: 1, pivot: null },
          points: [earlier, typedPoint('t-1', 'B1'), typedPoint('t-2', null), otherGps],
        },
      }),
    );
    const p = proposal(1);
    seed(p);
    await accept(p.id, 4);
    const placement = uow.mappings.rows.get(FILE)?.placement;
    expect(placement?.points.map((point) => point.id)).toEqual(['t-1', 't-2', 'g-other', p.id]);
    // The rest of the placement is untouched.
    expect(placement).toMatchObject({
      sourceCrs: 'egypt_red_belt',
      fitScaleWithTwoPoints: true,
      adjust: { dx: 1, dy: 2 },
    });
    expect(uow.mappings.rows.get(FILE)?.version).toBe(5);
  });

  it('refuses a stale version, a missing mapping and a decided proposal', async () => {
    const p = proposal(1);
    seed(p);
    expect(await reasonOf(accept(p.id, 7))).toEqual({
      reason: 'VERSION_MISMATCH',
      currentVersion: 1,
    });
    expect(uow.proposals.rows.get(p.id)?.status).toBe('pending');

    uow.mappings.rows.clear();
    expect(await reasonOf(accept(p.id, 1))).toMatchObject({ reason: 'NO_MAPPING' });

    uow.mappings.rows.set(FILE, mappingRecord());
    await accept(p.id, 1);
    expect(await reasonOf(accept(p.id, 2))).toMatchObject({ reason: 'ALREADY_DECIDED' });
    expect(uow.mappings.rows.get(FILE)?.version).toBe(2);
  });

  it('refuses while the file is being re-extracted, leaving mapping and proposal alone', async () => {
    const p = proposal(1);
    seed(p);
    uow.files.rows.set(FILE, { id: FILE, projectId: PROJECT, status: 'processing' } as CadFile);
    expect(await reasonOf(accept(p.id, 1))).toMatchObject({ reason: 'NOT_PROCESSED' });
    expect(uow.mappings.rows.get(FILE)?.version).toBe(1);
    expect(uow.proposals.rows.get(p.id)?.status).toBe('pending');
  });

  it('refuses more than the allowed number of control points', async () => {
    const points = Array.from({ length: MAX_CONTROL_POINTS }, (_, i) => typedPoint(`t${i}`, null));
    uow.mappings.rows.set(
      FILE,
      mappingRecord({
        placement: {
          sourceCrs: 'project',
          fitScaleWithTwoPoints: false,
          adjust: { dx: 0, dy: 0, rotationDeg: 0, scale: 1, pivot: null },
          points,
        },
      }),
    );
    const p = proposal(1);
    seed(p);
    expect(await reasonOf(accept(p.id, 1))).toMatchObject({ reason: 'TOO_MANY_POINTS' });
    expect(uow.mappings.rows.get(FILE)?.version).toBe(1);
    expect(uow.events.events).toEqual([]);
  });

  it('refuses when the item is no longer in the drawing', async () => {
    uow.proposals.centres.clear();
    const p = proposal(1);
    seed(p);
    expect(await reasonOf(accept(p.id, 1))).toMatchObject({ reason: 'ITEM_NOT_LOCATED' });
  });

  it("does not see another project's proposal", async () => {
    const p = proposal(1);
    seed(p);
    await expect(accept(p.id, 1, id(99))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('RejectGpsProposalUseCase', () => {
  const reject = (proposalId: string, projectId = PROJECT) =>
    new RejectGpsProposalUseCase(uow, clock).execute({
      projectId,
      proposalId,
      actorId: PM,
      reason: 'wrong place',
    });

  it('rejects a pending proposal with its reason and an event, leaving the mapping alone', async () => {
    const p = proposal(1);
    seed(p);
    const decided = await reject(p.id);
    expect(decided).toMatchObject({ status: 'rejected', rejectReason: 'wrong place' });
    expect(uow.mappings.rows.get(FILE)?.version).toBe(1);
    expect(uow.events.types()).toEqual(['gps_proposal.rejected']);
  });

  it('decides only once and stays inside the project', async () => {
    const p = proposal(1);
    seed(p);
    await reject(p.id);
    expect(await reasonOf(reject(p.id))).toMatchObject({ reason: 'ALREADY_DECIDED' });
    await expect(reject(p.id, id(99))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
