import { Readable } from 'node:stream';
import { AppError } from '../app-error.js';
import {
  isValidStorageKey,
  type ObjectStorage,
  type PutOptions,
  type StoredObject,
} from '../object-storage.port.js';
import { UploadMeter } from '../storage/upload-meter.js';

/** Test double with the same observable behaviour as the real adapters (write-once, limits, hash). */
export class InMemoryObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, Buffer>();

  async put(key: string, body: Readable, options: PutOptions): Promise<StoredObject> {
    if (!isValidStorageKey(key)) throw new AppError('VALIDATION_FAILED', 'Invalid storage key');
    if (this.objects.has(key)) throw new AppError('CONFLICT', 'Storage key already exists');
    const meter = new UploadMeter(options.maxBytes);
    const chunks: Buffer[] = [];
    for await (const chunk of body.pipe(meter) as AsyncIterable<Buffer>) chunks.push(chunk);
    this.objects.set(key, Buffer.concat(chunks));
    return { sizeBytes: meter.sizeBytes, sha256: meter.digest() };
  }

  async get(key: string): Promise<Readable> {
    const object = this.objects.get(key);
    if (!object) throw new AppError('NOT_FOUND', 'File not found');
    return Readable.from([object]);
  }

  async stat(key: string): Promise<{ sizeBytes: number } | null> {
    const object = this.objects.get(key);
    return object ? { sizeBytes: object.length } : null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}
