import {
  TILE_SOURCE_DESIGN_FEATURES,
  TILE_URL_TTL_SECONDS,
  type TileUrlResponse,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock } from '../../../common/clock.js';
import { parseRangeHeader } from '../../../common/http/byte-range.js';
import type { RangedObjectResponse } from '../../../common/http/download.js';
import type { ObjectStorage } from '../../../common/object-storage.port.js';
import type { DesignRevisionRepository } from '../domain/design-revision.repository.js';
import { signTile, verifyTileUri } from '../domain/tile-signature.js';
import { requireRevision } from './design-revision-queries.use-cases.js';
import type { TileConfig } from './ports.js';

/** Streams the revision's PMTiles archive after the normal permission checks (Range supported). */
export class GetRevisionTilesUseCase {
  constructor(
    private readonly revisions: DesignRevisionRepository,
    private readonly storage: ObjectStorage,
  ) {}

  async execute(
    projectId: string,
    revisionId: string,
    rangeHeader: string | undefined,
  ): Promise<RangedObjectResponse> {
    const revision = await requireRevision(this.revisions, projectId, revisionId);
    if (!revision.tilesStorageKey) throw new AppError('NOT_FOUND', 'The revision has no tiles');
    const stored = await this.storage.stat(revision.tilesStorageKey);
    if (!stored) throw new AppError('NOT_FOUND', 'The revision has no tiles');

    const request = parseRangeHeader(rangeHeader, stored.sizeBytes);
    if (request.kind === 'unsatisfiable') {
      return { kind: 'unsatisfiable', sizeBytes: stored.sizeBytes };
    }
    if (request.kind === 'partial') {
      return {
        kind: 'stream',
        sizeBytes: stored.sizeBytes,
        range: request.range,
        stream: await this.storage.get(revision.tilesStorageKey, request.range),
      };
    }
    return {
      kind: 'stream',
      sizeBytes: stored.sizeBytes,
      range: null,
      stream: await this.storage.get(revision.tilesStorageKey),
    };
  }
}

/** Signs a one-hour Martin URL template for a draft or published revision (ADR-021). */
export class CreateTileUrlUseCase {
  constructor(
    private readonly revisions: DesignRevisionRepository,
    private readonly config: TileConfig | null,
    private readonly clock: Clock,
  ) {}

  async execute(projectId: string, revisionId: string): Promise<TileUrlResponse> {
    // Not configured → the endpoint does not exist for this deployment.
    if (!this.config) throw new AppError('NOT_FOUND', 'Tiles are not available');
    const revision = await requireRevision(this.revisions, projectId, revisionId);
    if (revision.status !== 'draft' && revision.status !== 'published') {
      throw new AppError('NOT_FOUND', 'Tiles are not available for this revision');
    }

    const exp = Math.floor(this.clock.now().getTime() / 1000) + TILE_URL_TTL_SECONDS;
    const query = new URLSearchParams({
      p: projectId,
      r: revisionId,
      exp: String(exp),
      sig: signTile(this.config.secret, projectId, revisionId, exp),
    });
    return {
      // `{z}/{x}/{y}` stay literal for MapLibre, so the path is not built with URL encoding.
      urlTemplate: `${this.config.publicUrl}/${TILE_SOURCE_DESIGN_FEATURES}/{z}/{x}/{y}?${query.toString()}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }
}

/** Behind Caddy `forward_auth`: true when the forwarded tile URI carries a valid, unexpired signature. No I/O. */
export class VerifyTileRequestUseCase {
  constructor(
    private readonly config: TileConfig | null,
    private readonly clock: Clock,
  ) {}

  execute(forwardedUri: string | undefined): boolean {
    if (!this.config || !forwardedUri) return false;
    return verifyTileUri(
      this.config.secret,
      forwardedUri,
      Math.floor(this.clock.now().getTime() / 1000),
    );
  }
}
