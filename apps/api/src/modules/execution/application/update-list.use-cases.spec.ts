import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../../common/app-error.js';
import type { ObjectStorage } from '../../../common/object-storage.port.js';
import type { ExecutionScope, UpdateListQueries } from './ports.js';
import { GetUpdatePhotoUseCase, ListUpdatesUseCase } from './update-list.use-cases.js';

const PROJECT = '6f1a2b3c-0000-4000-8000-000000000001';
const PHOTO = '6f1a2b3c-0000-4000-8000-000000000002';
const SITES: ExecutionScope = { kind: 'sites', siteIds: ['6f1a2b3c-0000-4000-8000-000000000003'] };

function queries(key: string | null, seen: ExecutionScope[] = []): UpdateListQueries {
  return {
    list: async (_p, scope) => {
      seen.push(scope);
      return { items: [], total: 0 };
    },
    sites: async (_p, scope) => {
      seen.push(scope);
      return [{ id: '6f1a2b3c-0000-4000-8000-000000000003', name: 'S' }];
    },
    photoKey: async (_p, scope) => {
      seen.push(scope);
      return key;
    },
  };
}

function storage(sizeBytes: number | null): ObjectStorage {
  return {
    put: async () => ({ sizeBytes: 0, sha256: '' }),
    get: async () => Readable.from([Buffer.from('x')]),
    stat: async () => (sizeBytes === null ? null : { sizeBytes }),
    delete: async () => undefined,
  } as unknown as ObjectStorage;
}

describe('ListUpdatesUseCase', () => {
  it('passes the caller scope to the list and the site filter', async () => {
    const seen: ExecutionScope[] = [];
    const result = await new ListUpdatesUseCase(queries(null, seen)).execute({
      projectId: PROJECT,
      scope: SITES,
      query: { limit: 50, offset: 0 },
    });
    expect(result).toEqual({
      items: [],
      total: 0,
      sites: [{ id: SITES.kind === 'sites' ? SITES.siteIds[0] : '', name: 'S' }],
    });
    expect(seen).toEqual([SITES, SITES]);
  });
});

describe('GetUpdatePhotoUseCase', () => {
  it('answers NOT_FOUND when the photo is out of reach or not stored', async () => {
    const run = new GetUpdatePhotoUseCase(queries(null), storage(10)).execute({
      projectId: PROJECT,
      scope: SITES,
      photoId: PHOTO,
    });
    await expect(run).rejects.toBeInstanceOf(AppError);
    await expect(run).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('answers NOT_FOUND when the stored object is missing', async () => {
    const run = new GetUpdatePhotoUseCase(queries('k/1.jpg'), storage(null)).execute({
      projectId: PROJECT,
      scope: SITES,
      photoId: PHOTO,
    });
    await expect(run).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('streams the stored photo with its size', async () => {
    const result = await new GetUpdatePhotoUseCase(queries('k/1.jpg'), storage(10)).execute({
      projectId: PROJECT,
      scope: SITES,
      photoId: PHOTO,
    });
    expect(result.sizeBytes).toBe(10);
  });
});
