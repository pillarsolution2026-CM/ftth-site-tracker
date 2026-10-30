import type { RecordUpdateOp } from '@ftth/shared';
import { describe, expect, it } from 'vitest';
import type { ExecutionTx, ExecutionUnitOfWork } from './ports.js';
import { Phase2UnavailableCapabilities } from './phase2-capabilities.js';
import { PushSyncUseCase } from './push-sync.use-case.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const op: RecordUpdateOp = {
  kind: 'execution_update.record',
  clientOpId: id(1),
  capturedAt: '2026-10-30T10:00:00Z',
  payload: {
    featureId: id(2),
    designRevisionId: id(3),
    workType: 'civil',
    lines: [{ workOrderItemId: id(4), quantity: '1', role: 'work' }],
    label: null,
    note: null,
    gps: null,
    photos: [
      {
        photoId: id(5),
        requirementKey: 'general',
        sha256: 'a'.repeat(64),
        sizeBytes: 10,
        contentType: 'image/jpeg',
        takenAt: '2026-10-30T10:00:00Z',
        gps: null,
      },
    ],
    acknowledgedWarnings: [],
  },
};

/** A transaction where every check passes and the insert hits `constraint`. */
function uowFailingOn(constraint: string): ExecutionUnitOfWork {
  const pgError = Object.assign(new Error('duplicate key'), { code: '23505', constraint });
  const tx: ExecutionTx = {
    lockProject: async () => undefined,
    findOperation: async () => null,
    insertOperation: async () => undefined,
    featureExists: async () => true,
    featureInPublishedRevision: async () => ({
      featureType: 'box',
      revisionPublishedAt: new Date(0),
    }),
    featureInScope: async () => true,
    latestPublishedRevision: async () => ({
      id: id(3),
      revNo: 1,
      publishedAt: new Date(0),
      hasTiles: false,
    }),
    featureInRevision: async () => true,
    findItems: async () => [{ id: id(4), workType: 'civil' }],
    wouldOverrun: async () => false,
    gpsDistanceM: async () => 0,
    anyPhotoExists: async () => false,
    insertUpdate: async () => {
      throw new Error('Failed query', { cause: pgError });
    },
    appendEvent: async () => undefined,
  };
  return { run: (work) => work(tx) };
}

describe('PushSyncUseCase races', () => {
  it('answers PHOTO_ID_REUSED when the same photo id lands in another project at the same time', async () => {
    const useCase = new PushSyncUseCase(
      uowFailingOn('execution_photos_pkey'),
      new Phase2UnavailableCapabilities(),
      { now: () => new Date() },
      { next: () => id(9) },
    );
    const results = await useCase.execute({
      projectId: id(10),
      userId: id(11),
      deviceId: id(12),
      scope: { kind: 'project' },
      ops: [op],
    });
    expect(results).toEqual([
      { clientOpId: op.clientOpId, outcome: 'rejected', code: 'PHOTO_ID_REUSED' },
    ]);
  });

  it('rethrows unrelated database errors', async () => {
    const useCase = new PushSyncUseCase(
      uowFailingOn('something_else'),
      new Phase2UnavailableCapabilities(),
      { now: () => new Date() },
      { next: () => id(9) },
    );
    await expect(
      useCase.execute({
        projectId: id(10),
        userId: id(11),
        deviceId: id(12),
        scope: { kind: 'project' },
        ops: [op],
      }),
    ).rejects.toThrow('Failed query');
  });
});
