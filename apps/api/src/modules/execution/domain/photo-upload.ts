/** JPEG: starts with SOI + marker (FF D8 FF) and ends with EOI (FF D9). */
export function looksLikeJpeg(bytes: Uint8Array): boolean {
  const n = bytes.length;
  return (
    n >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    bytes[n - 2] === 0xff &&
    bytes[n - 1] === 0xd9
  );
}

export type ChunkDecision =
  | { kind: 'append'; receivedAfter: number; complete: boolean }
  | { kind: 'offset_mismatch' }
  | { kind: 'too_large' }
  | { kind: 'empty' };

/** Decides what to do with a chunk at `offset` of `length` bytes for a photo of `sizeBytes`. */
export function decideChunk(input: {
  sizeBytes: number;
  receivedBytes: number;
  offset: number;
  length: number;
}): ChunkDecision {
  if (input.offset !== input.receivedBytes) return { kind: 'offset_mismatch' };
  if (input.length === 0) return { kind: 'empty' };
  const receivedAfter = input.receivedBytes + input.length;
  if (receivedAfter > input.sizeBytes) return { kind: 'too_large' };
  return { kind: 'append', receivedAfter, complete: receivedAfter === input.sizeBytes };
}
