import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';

/**
 * Encryption of data kept on the phone (ADR-025): photos, the offline bundle and the sensitive
 * columns of the local database. XChaCha20-Poly1305 (authenticated; 24-byte random nonces are
 * safe to generate at random for every message) with one 32-byte key per installation.
 *
 * Sealed bytes: 0x01 | nonce (24) | ciphertext + tag. Sealed text: "v1:" + base64 of that.
 */
const VERSION = 0x01;
const NONCE_BYTES = 24;
export const KEY_BYTES = 32;
const TEXT_PREFIX = 'v1:';

export type RandomBytes = (count: number) => Uint8Array;

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultError';
  }
}

export function sealBytes(key: Uint8Array, plain: Uint8Array, random: RandomBytes): Uint8Array {
  if (key.length !== KEY_BYTES) throw new VaultError('Key must be 32 bytes');
  const nonce = random(NONCE_BYTES);
  const sealed = xchacha20poly1305(key, nonce).encrypt(plain);
  const out = new Uint8Array(1 + NONCE_BYTES + sealed.length);
  out[0] = VERSION;
  out.set(nonce, 1);
  out.set(sealed, 1 + NONCE_BYTES);
  return out;
}

/** Throws VaultError when the data was altered or sealed with another key. */
export function openBytes(key: Uint8Array, sealed: Uint8Array): Uint8Array {
  if (sealed.length < 1 + NONCE_BYTES + 16 || sealed[0] !== VERSION) {
    throw new VaultError('Not sealed data');
  }
  try {
    return xchacha20poly1305(key, sealed.subarray(1, 1 + NONCE_BYTES)).decrypt(
      sealed.subarray(1 + NONCE_BYTES),
    );
  } catch {
    throw new VaultError('Sealed data was altered or the key is wrong');
  }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const [a = 0, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63];
    out += B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64[n & 63] : '=';
  }
  return out;
}

export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of clean) {
    buffer = (buffer << 6) | B64.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, index);
}

/** Async so the key can come from the OS keystore on first use. */
export interface Vault {
  sealBytes(plain: Uint8Array): Promise<Uint8Array>;
  openBytes(sealed: Uint8Array): Promise<Uint8Array>;
  sealText(plain: string): Promise<string>;
  openText(sealed: string): Promise<string>;
}

export function createVault(getKey: () => Promise<Uint8Array>, random: RandomBytes): Vault {
  let key: Promise<Uint8Array> | null = null;
  const keyOnce = () => (key ??= getKey());
  return {
    sealBytes: async (plain) => sealBytes(await keyOnce(), plain, random),
    openBytes: async (sealed) => openBytes(await keyOnce(), sealed),
    sealText: async (plain) =>
      TEXT_PREFIX +
      bytesToBase64(sealBytes(await keyOnce(), new TextEncoder().encode(plain), random)),
    openText: async (sealed) => {
      if (!sealed.startsWith(TEXT_PREFIX)) throw new VaultError('Not sealed text');
      const plain = openBytes(await keyOnce(), base64ToBytes(sealed.slice(TEXT_PREFIX.length)));
      return new TextDecoder().decode(plain);
    },
  };
}
