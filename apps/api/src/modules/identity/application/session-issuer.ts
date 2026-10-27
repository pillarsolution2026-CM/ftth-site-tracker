import type { TokenPair } from '@ftth/shared';
import type { RefreshTokenRepository } from '../domain/refresh-token.js';
import type { User } from '../domain/user.js';
import type { AccessTokenService, Clock, RefreshTokenFactory, SessionConfig } from './ports.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Builds access/refresh token pairs; shared by login and refresh. */
export class SessionIssuer {
  constructor(
    private readonly accessTokens: AccessTokenService,
    private readonly refreshFactory: RefreshTokenFactory,
    private readonly refreshTokens: RefreshTokenRepository,
    private readonly clock: Clock,
    private readonly config: SessionConfig,
  ) {}

  /** Starts a new token family (login). */
  async startSession(user: Pick<User, 'id' | 'isAdmin'>): Promise<TokenPair> {
    const next = this.newRefreshToken(user.id, this.refreshFactory.newFamilyId());
    await this.refreshTokens.insert(next.record);
    return this.pair(user, next.token);
  }

  /** Continues a family (refresh). Returns null if the rotation lost a race. */
  async continueSession(
    user: Pick<User, 'id' | 'isAdmin'>,
    familyId: string,
    currentTokenId: string,
  ): Promise<TokenPair | null> {
    const next = this.newRefreshToken(user.id, familyId);
    const rotated = await this.refreshTokens.rotate(currentTokenId, next.record, this.clock.now());
    return rotated ? this.pair(user, next.token) : null;
  }

  private newRefreshToken(userId: string, familyId: string) {
    const { token, hash } = this.refreshFactory.create();
    const expiresAt = new Date(this.clock.now().getTime() + this.config.refreshTtlDays * DAY_MS);
    return { token, record: { userId, familyId, tokenHash: hash, expiresAt } };
  }

  private pair(user: Pick<User, 'id' | 'isAdmin'>, refreshToken: string): TokenPair {
    return {
      accessToken: this.accessTokens.sign({ sub: user.id, isAdmin: user.isAdmin }),
      refreshToken,
      expiresIn: this.config.accessTtlSeconds,
    };
  }
}
