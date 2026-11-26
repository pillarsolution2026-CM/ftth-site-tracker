import type { Readable } from 'node:stream';
import type { UpdateListQuery, UpdateListResponse } from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { ObjectStorage } from '../../../common/object-storage.port.js';
import type { ExecutionScope, UpdateListQueries } from './ports.js';

/** ADR-059: one page of the recorded updates in the caller's reach, newest received first. */
export class ListUpdatesUseCase {
  constructor(private readonly queries: UpdateListQueries) {}

  async execute(input: {
    projectId: string;
    scope: ExecutionScope;
    query: UpdateListQuery;
  }): Promise<UpdateListResponse> {
    const { items, total } = await this.queries.list(input.projectId, input.scope, input.query);
    const sites = await this.queries.sites(input.projectId, input.scope);
    return { items, total, sites };
  }
}

/**
 * The image of an update photo. A photo outside the caller's sites answers 404 exactly like an
 * unknown id (ADR-054), so ids cannot be probed.
 */
export class GetUpdatePhotoUseCase {
  constructor(
    private readonly queries: UpdateListQueries,
    private readonly storage: ObjectStorage,
  ) {}

  async execute(input: {
    projectId: string;
    scope: ExecutionScope;
    photoId: string;
  }): Promise<{ stream: Readable; sizeBytes: number }> {
    const key = await this.queries.photoKey(input.projectId, input.scope, input.photoId);
    if (!key) throw new AppError('NOT_FOUND', 'Photo not found');
    const stat = await this.storage.stat(key);
    if (!stat) throw new AppError('NOT_FOUND', 'Photo not found');
    return { stream: await this.storage.get(key), sizeBytes: stat.sizeBytes };
  }
}
