import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createS3Client, S3ObjectStorage } from './s3-object-storage.js';

interface SentCommand {
  constructor: { name: string };
  input: { Key?: string; Body?: unknown; IfNoneMatch?: string };
}

/** A client double that records commands and keeps uploaded bodies in memory. */
function fakeClient() {
  const objects = new Map<string, Buffer>();
  const sent: string[] = [];
  // A real client (lib-storage reads its configuration) whose network calls are replaced.
  const client = createS3Client({
    endpoint: 'http://localhost:9000',
    bucket: 'bucket',
    accessKey: 'k',
    secretKey: 's',
    region: 'us-east-1',
  });
  const send = async (command: SentCommand) => {
    const name = command.constructor.name;
    sent.push(name);
    const key = command.input.Key ?? '';
    if (name === 'PutObjectCommand') {
      // lib-storage hands small bodies over as one buffer and large ones as a stream.
      const body = command.input.Body;
      if (body instanceof Uint8Array) {
        objects.set(key, Buffer.from(body));
      } else {
        const chunks: Buffer[] = [];
        for await (const chunk of body as AsyncIterable<Buffer>) chunks.push(chunk);
        objects.set(key, Buffer.concat(chunks));
      }
      return {};
    }
    if (name === 'HeadObjectCommand') {
      const object = objects.get(key);
      if (!object)
        throw Object.assign(new Error('NotFound'), { $metadata: { httpStatusCode: 404 } });
      return { ContentLength: object.length };
    }
    if (name === 'GetObjectCommand') {
      const object = objects.get(key);
      if (!object) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      return { Body: Readable.from([object]) };
    }
    if (name === 'DeleteObjectCommand') {
      objects.delete(key);
      return {};
    }
    throw new Error(`unexpected ${name}`);
  };
  client.send = send as unknown as typeof client.send;
  return { client, objects, sent };
}

const options = { contentType: 'application/octet-stream', maxBytes: 100 };
const KEY = 'projects/p/cad/f/original.dxf';

describe('S3ObjectStorage', () => {
  it('streams a put with size and sha256, refuses to overwrite, reads and deletes', async () => {
    const { client, objects } = fakeClient();
    const storage = new S3ObjectStorage(client, 'bucket');

    const stored = await storage.put(KEY, Readable.from([Buffer.from('hello')]), options);
    expect(stored).toEqual({
      sizeBytes: 5,
      sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    });
    expect(objects.get(KEY)?.toString()).toBe('hello');
    expect(await storage.stat(KEY)).toEqual({ sizeBytes: 5 });

    await expect(
      storage.put(KEY, Readable.from([Buffer.from('x')]), options),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    const chunks: Buffer[] = [];
    for await (const chunk of await storage.get(KEY)) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('hello');

    await storage.delete(KEY);
    expect(await storage.stat(KEY)).toBeNull();
    await expect(storage.get(KEY)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('enforces the size limit and stores nothing', async () => {
    const { client, objects } = fakeClient();
    const storage = new S3ObjectStorage(client, 'bucket');
    await expect(
      storage.put(KEY, Readable.from([Buffer.alloc(80), Buffer.alloc(80)]), options),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(objects.size).toBe(0);
  });

  it('rejects unsafe keys before talking to S3', async () => {
    const { client, sent } = fakeClient();
    const storage = new S3ObjectStorage(client, 'bucket');
    await expect(storage.get('../x')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(storage.put('a//b', Readable.from([]), options)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(sent).toEqual([]);
  });
});
