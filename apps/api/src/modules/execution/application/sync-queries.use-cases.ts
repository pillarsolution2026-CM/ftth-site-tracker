import type { OfflineBundle, SyncChangesResponse } from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock } from '../../../common/clock.js';
import type { AsBuiltEditFeed, AsBuiltStateReader } from '../../asbuilt/application/ports.js';
import type { ExecutionCapabilities, ExecutionReadQueries, ExecutionScope } from './ports.js';

/** Offline bundle for the supervisor app: design, catalog and settings in the caller's scope. */
export class GetOfflineBundleUseCase {
  constructor(
    private readonly queries: ExecutionReadQueries,
    private readonly capabilities: ExecutionCapabilities,
    private readonly clock: Clock,
    private readonly asBuilt: AsBuiltStateReader,
  ) {}

  async execute(input: {
    projectId: string;
    /** ADR-049 part B: the drawing whose features the bundle carries; default the General published last. */
    drawingId?: string | undefined;
    scope: ExecutionScope;
    /** Reach of `asbuilt:read`; null when no assignment grants it (then no As-Built state). */
    asBuiltScope: ExecutionScope | null;
  }): Promise<OfflineBundle> {
    const project = await this.queries.projectInfo(input.projectId);
    if (!project) throw new AppError('NOT_FOUND', 'Project not found');
    // ADR-054: a supervisor gets only the drawings of his sites. A drawing of another site (or an
    // unassigned one) answers 404 exactly like an unknown id, so ids cannot be probed.
    const drawings = await this.queries.publishedDrawings(input.projectId, input.scope);
    if (input.drawingId && !drawings.some((d) => d.drawingId === input.drawingId)) {
      throw new AppError('NOT_FOUND', 'No published revision for this drawing');
    }
    // Project-wide: the General published last when none is picked. A site scope picks among his
    // own drawings only (never another site's General).
    const revision =
      input.scope.kind === 'project'
        ? await this.queries.latestPublishedRevision(input.projectId, input.drawingId)
        : (drawings.find((d) => d.drawingId === input.drawingId)?.revision ??
          [...drawings]
            .filter((d) => d.kind === 'general')
            .sort((a, b) => b.revision.publishedAt.getTime() - a.revision.publishedAt.getTime())[0]
            ?.revision ??
          null);
    const features = revision
      ? await this.queries.featuresInScope(input.projectId, revision.id, input.scope)
      : [];
    return {
      serverTime: this.clock.now().toISOString(),
      project,
      scope:
        input.scope.kind === 'project'
          ? { kind: 'project' }
          : { kind: 'sites', siteIds: [...input.scope.siteIds] },
      drawings: drawings.map((d) => ({
        drawingId: d.drawingId,
        siteId: d.siteId,
        siteName: d.siteName,
        kind: d.kind,
        ordinal: d.ordinal,
        revision: {
          id: d.revision.id,
          revNo: d.revision.revNo,
          publishedAt: d.revision.publishedAt.toISOString(),
          tilesAvailable: d.revision.hasTiles,
        },
      })),
      revision: revision
        ? {
            id: revision.id,
            ...(revision.drawingId ? { drawingId: revision.drawingId } : {}),
            revNo: revision.revNo,
            publishedAt: revision.publishedAt.toISOString(),
            tilesAvailable: revision.hasTiles,
          }
        : null,
      features,
      catalog: await this.queries.catalog(input.projectId, input.scope),
      elementGroups: await this.queries.elementGroups(),
      asBuilt: input.asBuiltScope
        ? await this.asBuilt.stateInScope(input.projectId, input.asBuiltScope)
        : [],
      settings: {
        gpsWarningDistanceM: this.capabilities.gpsWarningDistanceM(),
        suggestedQuantity: this.capabilities.suggestedQuantity(),
        photoRequirements: this.capabilities.photoRequirements(),
      },
    };
  }
}

/**
 * Updates and As-Built edits in the caller's scope after a server cursor (never a device clock).
 * Both kinds share `execution_sync_seq`: the page is the lowest `limit` sequence numbers of the
 * two, the cursor the highest one returned.
 */
export class GetSyncChangesUseCase {
  constructor(
    private readonly queries: ExecutionReadQueries,
    private readonly clock: Clock,
    private readonly feed: AsBuiltEditFeed,
  ) {}

  async execute(input: {
    projectId: string;
    scope: ExecutionScope;
    asBuiltScope: ExecutionScope | null;
    cursor: string;
    limit: number;
  }): Promise<SyncChangesResponse> {
    // One extra row of each kind tells whether more remain after the merged page.
    const { updates, seqs } = await this.queries.changes(
      input.projectId,
      input.scope,
      input.cursor,
      input.limit + 1,
    );
    const edits = input.asBuiltScope
      ? await this.feed.editsAfter(
          input.projectId,
          input.asBuiltScope,
          input.cursor,
          input.limit + 1,
        )
      : [];
    const merged = [
      ...updates.map((update, index) => ({
        seq: BigInt(seqs[index] ?? '0'),
        kind: 'update' as const,
        update,
      })),
      ...edits.map(({ seq, edit }) => ({ seq: BigInt(seq), kind: 'edit' as const, edit })),
    ].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
    const page = merged.slice(0, input.limit);
    const last = page[page.length - 1];
    return {
      serverTime: this.clock.now().toISOString(),
      cursor: last ? last.seq.toString() : input.cursor,
      hasMore: merged.length > input.limit,
      updates: page.flatMap((item) => (item.kind === 'update' ? [item.update] : [])),
      asBuiltEdits: page.flatMap((item) => (item.kind === 'edit' ? [item.edit] : [])),
    };
  }
}
