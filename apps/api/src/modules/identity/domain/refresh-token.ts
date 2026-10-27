export interface RefreshTokenRecord {
  id: string;
  userId: string;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
}

export interface NewRefreshToken {
  userId: string;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
}

export interface RefreshTokenRepository {
  insert(token: NewRefreshToken): Promise<void>;
  findByHash(tokenHash: string): Promise<RefreshTokenRecord | null>;
  /**
   * Atomically marks `currentId` as rotated and stores `next`.
   * Returns false (and stores nothing) if the current token was already rotated or revoked,
   * which is how concurrent double-use of one token is caught.
   */
  rotate(currentId: string, next: NewRefreshToken, now: Date): Promise<boolean>;
  revokeFamily(familyId: string, now: Date): Promise<void>;
}
