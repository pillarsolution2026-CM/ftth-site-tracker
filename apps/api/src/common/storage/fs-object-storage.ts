import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, link, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '../app-error.js';
import {
  type ByteRange,
  isValidStorageKey,
  type ObjectStorage,
  type PutOptions,
  type StoredObject,
} from '../object-storage.port.js';
import { UploadMeter } from './upload-meter.js';

/**
 * Directories are group-writable (and setgid) so the CAD worker, which joins the API's group, can
 * add `converted.dxf` next to an original the API created.
 */
const DIR_MODE = 0o2775;
const FILE_MODE = 0o664;
const TEMP_DIR = '.tmp'; // never a valid key segment (keys start with [a-z0-9])

/** `fs` adapter: a directory shared by the API and the CAD worker (ADR-012). */
export class FsObjectStorage implements ObjectStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async put(key: string, body: Readable, options: PutOptions): Promise<StoredObject> {
    const destination = this.pathFor(key);
    await this.ensureDir(dirname(destination));
    const tempDir = join(this.root, TEMP_DIR);
    await this.ensureDir(tempDir);

    const temp = join(tempDir, randomUUID());
    const meter = new UploadMeter(options.maxBytes);
    try {
      await pipeline(body, meter, createWriteStream(temp, { flags: 'wx', mode: FILE_MODE }));
      await this.publish(temp, destination);
    } finally {
      await rm(temp, { force: true });
    }
    return { sizeBytes: meter.sizeBytes, sha256: meter.digest() };
  }

  async get(key: string, range?: ByteRange): Promise<Readable> {
    const path = this.pathFor(key);
    if ((await this.stat(key)) === null) throw new AppError('NOT_FOUND', 'File not found');
    return range
      ? createReadStream(path, { start: range.start, end: range.end })
      : createReadStream(path);
  }

  async stat(key: string): Promise<{ sizeBytes: number } | null> {
    try {
      const info = await stat(this.pathFor(key));
      return info.isFile() ? { sizeBytes: info.size } : null;
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  /** The only place a key becomes a path: validated, then proven to stay under the root. */
  private pathFor(key: string): string {
    if (!isValidStorageKey(key)) throw new AppError('VALIDATION_FAILED', 'Invalid storage key');
    const path = resolve(this.root, key);
    if (!path.startsWith(this.root + sep)) {
      throw new AppError('VALIDATION_FAILED', 'Invalid storage key');
    }
    return path;
  }

  /** Atomic, write-once publish: a hard link fails with EEXIST instead of overwriting. */
  private async publish(temp: string, destination: string): Promise<void> {
    try {
      await link(temp, destination);
    } catch (error) {
      if (isErrno(error, 'EEXIST')) throw new AppError('CONFLICT', 'Storage key already exists');
      throw error;
    }
  }

  private async ensureDir(directory: string): Promise<void> {
    const missing: string[] = [];
    for (let current = directory; current.startsWith(this.root); current = dirname(current)) {
      if (await isDirectory(current)) break;
      missing.unshift(current);
      if (current === this.root) break;
    }
    for (const path of missing) {
      try {
        await mkdir(path);
        await chmod(path, DIR_MODE); // mkdir's mode is masked by the umask
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) throw error; // created concurrently
      }
    }
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
