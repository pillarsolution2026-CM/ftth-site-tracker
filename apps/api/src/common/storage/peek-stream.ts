import { Readable } from 'node:stream';

export interface Peeked {
  /** The first bytes (fewer if the stream is shorter). */
  head: Buffer;
  /** Yields every byte again, including `head`. Use this instead of the original stream. */
  stream: Readable;
}

/** Reads up to `bytes` from the start of a stream without consuming them (content sniffing). */
export function peekStream(source: Readable, bytes: number): Promise<Peeked> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;

    const cleanup = (): void => {
      source.off('data', onData);
      source.off('end', onEnd);
      source.off('error', onError);
    };
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      length += chunk.length;
      if (length < bytes) return;
      source.pause();
      cleanup();
      const all = Buffer.concat(chunks);
      source.unshift(all);
      resolve({ head: all.subarray(0, bytes), stream: source });
    };
    const onEnd = (): void => {
      cleanup();
      const all = Buffer.concat(chunks);
      resolve({
        head: all.subarray(0, bytes),
        stream: Readable.from(all.length > 0 ? [all] : [], { objectMode: false }),
      });
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    source.on('data', onData);
    source.once('end', onEnd);
    source.once('error', onError);
  });
}
