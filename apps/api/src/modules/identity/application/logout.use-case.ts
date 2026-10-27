import type { RefreshRequest } from '@ftth/shared';
import type { RefreshTokenRepository } from '../domain/refresh-token.js';
import type { Clock, RefreshTokenFactory } from './ports.js';

export class LogoutUseCase {
  constructor(
    private readonly refreshTokens: RefreshTokenRepository,
    private readonly refreshFactory: RefreshTokenFactory,
    private readonly clock: Clock,
  ) {}

  /** Idempotent: an unknown token is not an error (nothing to reveal, nothing to revoke). */
  async execute(request: RefreshRequest): Promise<void> {
    const token = await this.refreshTokens.findByHash(
      this.refreshFactory.hash(request.refreshToken),
    );
    if (token) await this.refreshTokens.revokeFamily(token.familyId, this.clock.now());
  }
}
