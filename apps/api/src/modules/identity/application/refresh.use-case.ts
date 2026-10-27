import type { RefreshRequest, TokenPair } from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { RefreshTokenRepository } from '../domain/refresh-token.js';
import type { UserRepository } from '../domain/user.js';
import type { Clock, RefreshTokenFactory } from './ports.js';
import type { SessionIssuer } from './session-issuer.js';

/** A token rotated this recently is treated as a benign client retry/race, not as theft. */
export const REFRESH_REUSE_GRACE_MS = 30_000;

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
    if (!current) throw this.invalid();

    // A rotated token must never be presented again: assume it leaked and kill the whole family.
    if (current.rotatedAt) {
      if (this.withinGrace(current.rotatedAt, now)) throw this.invalid();
      return this.rejectReuse(current.familyId, now);
    }
    if (current.revokedAt) throw this.invalid();
    if (current.expiresAt <= now) throw new AppError('TOKEN_EXPIRED', 'Refresh token has expired');

    const user = await this.users.findById(current.userId);
    if (!user || !user.isActive) {
      await this.refreshTokens.revokeFamily(current.familyId, now);
      throw this.invalid();
    }

    const tokens = await this.sessions.continueSession(user, current.familyId, current.id);
    // Lost the rotation race: another request rotated it an instant ago, i.e. inside the grace window.
    if (!tokens) throw this.invalid();
    return tokens;
  }

  private withinGrace(rotatedAt: Date, now: Date): boolean {
    return now.getTime() - rotatedAt.getTime() < REFRESH_REUSE_GRACE_MS;
  }

  private invalid(): AppError {
    return new AppError('TOKEN_INVALID', 'Refresh token is not valid');
  }

  private async rejectReuse(familyId: string, now: Date): Promise<never> {
    await this.refreshTokens.revokeFamily(familyId, now);
    throw new AppError('REFRESH_TOKEN_REUSED', 'Refresh token was already used; session revoked');
  }
}
