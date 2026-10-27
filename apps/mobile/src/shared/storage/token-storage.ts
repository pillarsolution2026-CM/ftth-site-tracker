import * as SecureStore from 'expo-secure-store';
import { TokenPairSchema, type TokenPair } from '@ftth/shared';

/** Where the session tokens live. Production uses the OS secure store; tests use the in-memory fake. */
export interface TokenStorage {
  read(): Promise<TokenPair | null>;
  write(tokens: TokenPair): Promise<void>;
  clear(): Promise<void>;
}

const TOKENS_KEY = 'ftth.tokens';

export class SecureTokenStorage implements TokenStorage {
  async read(): Promise<TokenPair | null> {
    const raw = await SecureStore.getItemAsync(TOKENS_KEY);
    if (!raw) return null;
    try {
      const parsed = TokenPairSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async write(tokens: TokenPair): Promise<void> {
    await SecureStore.setItemAsync(TOKENS_KEY, JSON.stringify(tokens));
  }

  async clear(): Promise<void> {
    await SecureStore.deleteItemAsync(TOKENS_KEY);
  }
}

export class InMemoryTokenStorage implements TokenStorage {
  private tokens: TokenPair | null;

  constructor(initial: TokenPair | null = null) {
    this.tokens = initial;
  }

  async read(): Promise<TokenPair | null> {
    return this.tokens;
  }

  async write(tokens: TokenPair): Promise<void> {
    this.tokens = tokens;
  }

  async clear(): Promise<void> {
    this.tokens = null;
  }
}
