import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isValidStorageKey, storageKeys } from '../object-storage.port.js';
import { FsObjectStorage } from './fs-object-storage.js';

let root: string;
let storage: FsObjectStorage;
const options = { contentType: 'application/octet-stream', maxBytes: 1024 };
const KEY = 'projects/p1/cad/f1/original.dxf';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ftth-storage-'));
  storage = new FsObjectStorage(join(root, 'store'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const body = (text: string) => Readable.from([Buffer.from(text)]);
const leftovers = async () => readdir(join(root, 'store', '.tmp')).catch(() => []);

describe('FsObjectStorage', () => {
  it('writes a file and reports its size and sha256 (computed while streaming)', async () => {
    const stored = await storage.put(KEY, body('hello world'), options);
    expect(stored).toEqual({
      sizeBytes: 11,
      sha256: createHash('sha256').update('hello world').digest('hex'),
    });
    expect(await readFile(join(root, 'store', KEY), 'utf8')).toBe('hello world');
    expect(await storage.stat(KEY)).toEqual({ sizeBytes: 11 });
    expect(await leftovers()).toEqual([]);
  });

  it('is write-once: a second put to the same key fails and keeps the original bytes', async () => {
    await storage.put(KEY, body('first'), options);
    await expect(storage.put(KEY, body('second'), options)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(await readFile(join(root, 'store', KEY), 'utf8')).toBe('first');
    expect(await leftovers()).toEqual([]);
  });

  it('stops at maxBytes with FILE_TOO_LARGE and leaves neither the key nor a temp file', async () => {
    const big = Readable.from([Buffer.alloc(600), Buffer.alloc(600)]);
    await expect(storage.put(KEY, big, options)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(await storage.stat(KEY)).toBeNull();
    expect(await leftovers()).toEqual([]);
  });

  it('accepts a file of exactly maxBytes', async () => {
    const stored = await storage.put(KEY, Readable.from([Buffer.alloc(1024)]), options);
    expect(stored.sizeBytes).toBe(1024);
  });

  it('cleans up when the source stream fails midway', async () => {
    const failing = new Readable({
      read() {
        this.push(Buffer.from('partial'));
        this.destroy(new Error('connection lost'));
      },
    });
    await expect(storage.put(KEY, failing, options)).rejects.toThrow('connection lost');
    expect(await storage.stat(KEY)).toBeNull();
    expect(await leftovers()).toEqual([]);
  });

  it('reads back, reports absence, and deletes idempotently', async () => {
    await storage.put(KEY, body('data'), options);
    const chunks: Buffer[] = [];
    for await (const chunk of await storage.get(KEY)) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('data');

    await storage.delete(KEY);
    await storage.delete(KEY);
    expect(await storage.stat(KEY)).toBeNull();
    await expect(storage.get(KEY)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects keys that could leave the root, for every operation', async () => {
    const bad = [
      '../escape',
      'a/../../escape',
      '/etc/passwd',
      'a//b',
      'a/b/',
      '.tmp/x',
      'a/./b',
      'A/upper',
      'a\\b',
      'a/b\0c',
      '',
    ];
    for (const key of bad) {
      expect(isValidStorageKey(key), key).toBe(false);
      await expect(storage.put(key, body('x'), options)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
      await expect(storage.get(key)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(storage.stat(key)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(storage.delete(key)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    expect((await stat(root)).isDirectory()).toBe(true);
    expect(await readdir(root)).not.toContain('escape');
  });

  it('accepts the canonical keys', () => {
    for (const key of [
      storageKeys.cadOriginal(
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        'dwg',
      ),
      storageKeys.cadConverted(
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
      ),
      storageKeys.workOrderAttachment('p', 'w', 'a', 'pdf'),
    ]) {
      expect(isValidStorageKey(key), key).toBe(true);
    }
  });
});
