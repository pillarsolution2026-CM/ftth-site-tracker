import type { OfflineBundle, SyncChangesResponse } from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock } from '../../../common/clock.js';
import type { ExecutionCapabilities, ExecutionReadQueries, ExecutionScope } from './ports.js';

/** Offline bundle for the supervisor app: design, catalog and settings in the caller's scope. */
export class GetOfflineBundleUseCase {
  constructor(
    private readonly queries: ExecutionReadQueries,
    private readonly capabilities: ExecutionCapabilities,
    private readonly clock: Clock,
  ) {}

  async execute(input: { projectId: string; scope: ExecutionScope }): Promise<OfflineBundle> {
    const project = await this.queries.projectInfo(input.projectId);
    if (!project) throw new AppError('NOT_FOUND', 'Project not found');
    const revision = await this.queries.latestPublishedRevision(input.projectId);
    const features = revision
      ? await this.queries.featuresInScope(input.projectId, revision.id, input.scope)
      : [];
    return {
      serverTime: this.clock.now().toISOString(),
      project,
      scope:
        input.scope.kind === 'project'
          ? { kind: 'project' }
          : { kind: 'zones', zoneIds: [...input.scope.zoneIds] },
      revision: revision
        ? {
            id: revision.id,
            revNo: revision.revNo,
            publishedAt: revision.publishedAt.toISOString(),
            tilesAvailable: revision.hasTiles,
          }
        : null,
      features,
      catalog: await this.queries.catalog(input.projectId),
      settings: {
        gpsWarningDistanceM: this.capabilities.gpsWarningDistanceM(),
        suggestedQuantity: this.capabilities.suggestedQuantity(),
        photoRequirements: this.capabilities.photoRequirements(),
      },
    };
  }
}

/** Updates in the caller's scope after a server cursor (never a device clock). */
export class GetSyncChangesUseCase {
  constructor(
    private readonly queries: ExecutionReadQueries,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    projectId: string;
    scope: ExecutionScope;
    cursor: string;
    limit: number;
  }): Promise<SyncChangesResponse> {
    const { updates, seqs } = await this.queries.changes(
      input.projectId,
      input.scope,
      input.cursor,
      input.limit + 1,
    );
    const hasMore = updates.length > input.limit;
    const page = updates.slice(0, input.limit);
    return {
      serverTime: this.clock.now().toISOString(),
      cursor: page.length > 0 ? (seqs[page.length - 1] ?? input.cursor) : input.cursor,
      hasMore,
      updates: page,
    };
  }
}
