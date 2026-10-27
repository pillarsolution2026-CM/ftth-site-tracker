import { hash, verify } from '@node-rs/argon2';
import type { PasswordHasher } from '../application/ports.js';

/** argon2id (the @node-rs/argon2 default algorithm) with its default OWASP-grade cost parameters. */
export class Argon2PasswordHasher implements PasswordHasher {
  hash(password: string): Promise<string> {
    return hash(password);
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false; // malformed stored hash must not leak as a 500
    }
  }
}
