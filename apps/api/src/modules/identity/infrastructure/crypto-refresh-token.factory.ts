import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { RefreshTokenFactory } from '../application/ports.js';

export class CryptoRefreshTokenFactory implements RefreshTokenFactory {
  create(): { token: string; hash: string } {
    const token = randomBytes(48).toString('base64url');
    return { token, hash: this.hash(token) };
  }

  hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  newFamilyId(): string {
    return randomUUID();
  }
}
