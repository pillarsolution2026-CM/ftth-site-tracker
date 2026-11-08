import type { ProposePlacementPointOp } from '@ftth/shared';
import { describe, expect, it } from 'vitest';
import { Phase2UnavailableCapabilities } from './phase2-capabilities.js';
import type { ExecutionTx, NewGpsProposal } from './ports.js';
import { PushSyncUseCase, type PushInput } from './push-sync.use-case.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const propose = (accuracyM = 3): ProposePlacementPointOp => ({
  kind: 'placement_point.propose',
  clientOpId: id(21),
  capturedAt: '2026-11-08T10:00:00Z',
  payload: {
    designRevisionId: id(3),
    featureId: id(2),
    fix: { lat: 30, lon: 31, accuracyM, at: '2026-11-08T10:00:00Z' },
    photo: null,
    note: null,
  },
});

function setup(featureType: string) {
  const calls = { inserted: [] as NewGpsProposal[], scopeChecks: 0 };
  const tx = {
    lockProject: async () => undefined,
    findOperation: async () => null,
    insertOperation: async () => undefined,
    featureExists: async () => true,
    proposalTarget: async () => ({ featureType, code: 'MH-1', handle: 'H7', cadFileId: id(30) }),
    featureInScope: async () => {
      calls.scopeChecks += 1;
      return false;
    },
    anyPhotoExists: async () => false,
    insertGpsProposal: async (proposal: NewGpsProposal) => {
      calls.inserted.push(proposal);
    },
    appendEvent: async () => undefined,
  } as unknown as ExecutionTx;
  const useCase = new PushSyncUseCase(
    { run: (work) => work(tx) },
    new Phase2UnavailableCapabilities(),
    { now: () => new Date('2026-11-08T10:00:05Z') },
    { next: () => id(9) },
  );
  const run = (
    op: ProposePlacementPointOp,
    scope: PushInput['scope'] = { kind: 'zones', zoneIds: [id(50)] },
  ) => useCase.execute({ projectId: id(10), userId: id(11), deviceId: id(12), scope, ops: [op] });
  return { calls, run };
}

describe('PushSyncUseCase placement_point.propose', () => {
  it('applies for any zone: copies the handle and file of the item, no zone check', async () => {
    const { calls, run } = setup('mh');
    expect(await run(propose())).toEqual([
      { clientOpId: id(21), outcome: 'applied', updateId: id(9) },
    ]);
    expect(calls.scopeChecks).toBe(0);
    expect(calls.inserted).toHaveLength(1);
    expect(calls.inserted[0]).toMatchObject({
      id: id(9),
      handle: 'H7',
      cadFileId: id(30),
      code: 'MH-1',
      featureType: 'mh',
      proposedBy: id(11),
    });
  });

  it.each(['route', 'ring'])('refuses a %s item', async (type) => {
    const { calls, run } = setup(type);
    expect(await run(propose())).toEqual([
      { clientOpId: id(21), outcome: 'rejected', code: 'FEATURE_TYPE_NOT_ALLOWED' },
    ]);
    expect(calls.inserted).toEqual([]);
  });

  it('refuses a fix worse than 5 m even if the contract check was bypassed', async () => {
    const { calls, run } = setup('box');
    expect(await run(propose(5.01))).toEqual([
      { clientOpId: id(21), outcome: 'rejected', code: 'GPS_ACCURACY_TOO_LOW' },
    ]);
    expect(calls.inserted).toEqual([]);
  });

  it('refuses a caller whose roles grant no execution:write', async () => {
    const { calls, run } = setup('box');
    expect(await run(propose(), null)).toEqual([
      { clientOpId: id(21), outcome: 'rejected', code: 'FEATURE_OUT_OF_SCOPE' },
    ]);
    expect(calls.inserted).toEqual([]);
  });
});
