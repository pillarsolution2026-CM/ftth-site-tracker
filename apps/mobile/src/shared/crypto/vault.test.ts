import { testRandom } from './test-random';
import {
  base64ToBytes,
  bytesToBase64,
  createVault,
  openBytes,
  sealBytes,
  VaultError,
} from './vault';

const random = testRandom;
const key = random(32);

describe('vault', () => {
  it('round-trips bytes and text, with a fresh nonce every time', async () => {
    const plain = Uint8Array.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    const a = sealBytes(key, plain, random);
    const b = sealBytes(key, plain, random);
    expect(Array.from(a)).not.toEqual(Array.from(b));
    expect(Array.from(openBytes(key, a))).toEqual(Array.from(plain));

    const vault = createVault(async () => key, random);
    const text = JSON.stringify({ note: 'حفر يدوي', gps: { lat: 30.18, lon: 31.2 } });
    const sealed = await vault.sealText(text);
    expect(sealed.startsWith('v1:')).toBe(true);
    expect(sealed).not.toContain('30.18');
    expect(await vault.openText(sealed)).toBe(text);
  });

  it('refuses altered data, another key, and unsealed input', async () => {
    const sealed = sealBytes(key, Uint8Array.from([1, 2, 3]), random);
    const altered = Uint8Array.from(sealed);
    altered[altered.length - 1] = (altered[altered.length - 1] ?? 0) ^ 1;
    expect(() => openBytes(key, altered)).toThrow(VaultError);
    expect(() => openBytes(random(32), sealed)).toThrow(VaultError);
    expect(() => openBytes(key, Uint8Array.from([0xff, 0xd8]))).toThrow(/Not sealed/);
    await expect(createVault(async () => key, random).openText('{"plain":1}')).rejects.toThrow(
      /Not sealed/,
    );
    expect(() => sealBytes(random(16), Uint8Array.from([1]), random)).toThrow(/32 bytes/);
  });

  it('reads the key once', async () => {
    const getKey = jest.fn(async () => key);
    const vault = createVault(getKey, random);
    await vault.sealText('a');
    await vault.openBytes(await vault.sealBytes(Uint8Array.from([1])));
    expect(getKey).toHaveBeenCalledTimes(1);
  });

  it('encodes base64 per RFC 4648 for every padding length', () => {
    const vectors: [string, string][] = [
      ['', ''],
      ['f', 'Zg=='],
      ['fo', 'Zm8='],
      ['foo', 'Zm9v'],
      ['foob', 'Zm9vYg=='],
      ['fooba', 'Zm9vYmE='],
      ['foobar', 'Zm9vYmFy'],
    ];
    for (const [plain, encoded] of vectors) {
      const bytes = new TextEncoder().encode(plain);
      expect(bytesToBase64(bytes)).toBe(encoded);
      expect(new TextDecoder().decode(base64ToBytes(encoded))).toBe(plain);
    }
    const binary = Uint8Array.from([0, 255, 128, 62, 63]);
    expect(Array.from(base64ToBytes(bytesToBase64(binary)))).toEqual(Array.from(binary));
  });
});
