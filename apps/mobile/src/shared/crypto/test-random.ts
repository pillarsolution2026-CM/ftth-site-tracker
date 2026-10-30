/** Test-only random source (not cryptographic): distinct bytes on every call. */
let seed = 1;
export function testRandom(count: number): Uint8Array {
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    seed = (seed * 1_103_515_245 + 12_345) >>> 0;
    out[i] = seed >>> 24;
  }
  return out;
}
