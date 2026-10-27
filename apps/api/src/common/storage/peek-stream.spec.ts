import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { peekStream } from './peek-stream.js';
import { UploadMeter } from './upload-meter.js';

async function drain(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString();
}

describe('peekStream', () => {
  it('returns the head and leaves every byte readable', async () => {
    const source = Readable.from([Buffer.from('ab'), Buffer.from('cdef'), Buffer.from('gh')]);
    const { head, stream } = await peekStream(source, 5);
    expect(head.toString()).toBe('abcde');
    expect(await drain(stream)).toBe('abcdefgh');
  });

  it('handles a stream shorter than the requested head', async () => {
    const { head, stream } = await peekStream(Readable.from([Buffer.from('xy')]), 10);
    expect(head.toString()).toBe('xy');
    expect(await drain(stream)).toBe('xy');
  });

  it('handles an empty stream', async () => {
    const { head, stream } = await peekStream(Readable.from([]), 4);
    expect(head.length).toBe(0);
    expect(await drain(stream)).toBe('');
  });
});

describe('UploadMeter', () => {
  it('counts, hashes and enforces the limit', async () => {
    const meter = new UploadMeter(4);
    const result = Readable.from([Buffer.from('abcd')]).pipe(meter);
    await drain(result);
    expect(meter.sizeBytes).toBe(4);
    expect(meter.digest()).toBe('88d4266fd4e6338d13b845fcf289579d209c897823b9217da3e161936f031589');

    const strict = new UploadMeter(3);
    await expect(drain(Readable.from([Buffer.from('abcd')]).pipe(strict))).rejects.toMatchObject({
      code: 'FILE_TOO_LARGE',
    });
  });
});
