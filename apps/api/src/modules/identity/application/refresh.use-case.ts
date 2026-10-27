import type { RefreshRequest, TokenPair } from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { RefreshTokenRepository } from '../domain/refresh-token.js';
import type { UserRepository } from '../domain/user.js';
import type { Clock, RefreshTokenFactory } from './ports.js';
import type { SessionIssuer } from './session-issuer.js';

export class RefreshUseCase {
  constructor(
    private readonly refreshTokens: RefreshTokenRepository,
    private readonly refreshFactory: RefreshTokenFactory,
    private readonly users: UserRepository,
    private readonly sessions: SessionIssuer,
    private readonly clock: Clock,
  ) {}

  async execute(request: RefreshRequest): Promise<TokenPair> {
    const now = this.clock.now();
    const current = await this.refreshTokens.findByHash(
      this.refreshFactory.hash(request.refreshToken),
    );
    if (!current) throw new AppError('TOKEN_INVALID', 'Refresh token is not valid');

    // A rotated token must never be presented again: assume it leaked and kill the whole family.
    if (current.rotatedAt) return this.rejectReuse(current.familyId, now);
    if (current.revokedAt) throw new AppError('TOKEN_INVALID', 'Refresh token is not valid');
    if (current.expiresAt <= now) throw new AppError('TOKEN_EXPIRED', 'Refresh token has expired');

    const user = await this.users.findById(current.userId);
    if (!user || !user.isActive) {
      await this.refreshTokens.revokeFamily(current.familyId, now);
      throw new AppError('TOKEN_INVALID', 'Refresh token is not valid');
    }

    const tokens = await this.sessions.continueSession(user, current.familyId, current.id);
    // Lost the rotation race: another request already used this token, which is reuse.
    return tokens ?? this.rejectReuse(current.familyId, now);
  }

  private async rejectReuse(familyId: string, now: Date): Promise<never> {
    await this.refreshTokens.revokeFamily(familyId, now);
    throw new AppError('REFRESH_TOKEN_REUSED', 'Refresh token was already used; session revoked');
  }
}
