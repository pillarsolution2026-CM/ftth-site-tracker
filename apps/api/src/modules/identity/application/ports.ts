import type { AccessTokenClaims } from '@ftth/shared';

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(passwordHash: string, password: string): Promise<boolean>;
}

export interface AccessTokenService {
  sign(claims: AccessTokenClaims): string;
  /** Throws AppError TOKEN_EXPIRED / TOKEN_INVALID. */
  verify(token: string): AccessTokenClaims;
}

export interface RefreshTokenFactory {
  /** Opaque random token (returned to the client once) and the hash that is stored. */
  create(): { token: string; hash: string };
  hash(token: string): string;
  newFamilyId(): string;
}

export interface Clock {
  now(): Date;
}

export interface SessionConfig {
  accessTtlSeconds: number;
  refreshTtlDays: number;
}
