import { AccessTokenClaimsSchema, type AccessTokenClaims } from '@ftth/shared';
import jwt from 'jsonwebtoken';
import { AppError } from '../../../common/app-error.js';
import type { AccessTokenService } from '../application/ports.js';

export class JwtAccessTokenService implements AccessTokenService {
  constructor(
    private readonly secret: string,
    private readonly ttlSeconds: number,
  ) {}

  sign(claims: AccessTokenClaims): string {
    return jwt.sign({ isAdmin: claims.isAdmin }, this.secret, {
      algorithm: 'HS256',
      subject: claims.sub,
      expiresIn: this.ttlSeconds,
    });
  }

  verify(token: string): AccessTokenClaims {
    try {
      // Pin the algorithm: never let the token header choose it.
      const payload = jwt.verify(token, this.secret, { algorithms: ['HS256'] });
      const claims = AccessTokenClaimsSchema.safeParse(payload);
      if (!claims.success) throw new AppError('TOKEN_INVALID', 'Access token is not valid');
      return claims.data;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof jwt.TokenExpiredError) {
        throw new AppError('TOKEN_EXPIRED', 'Access token has expired');
      }
      throw new AppError('TOKEN_INVALID', 'Access token is not valid');
    }
  }
}
