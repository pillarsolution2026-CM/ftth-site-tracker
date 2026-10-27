import { createHash, type Hash } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';
import { AppError } from '../app-error.js';

/**
 * Pass-through that counts bytes and hashes them while streaming (nothing is buffered), and fails
 * with FILE_TOO_LARGE as soon as more than `maxBytes` have gone through.
 */
export class UploadMeter extends Transform {
  private readonly hash: Hash = createHash('sha256');
  private bytes = 0;

  constructor(private readonly maxBytes: number) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      callback(new AppError('FILE_TOO_LARGE', `Upload exceeds ${this.maxBytes} bytes`));
      return;
    }
    this.hash.update(chunk);
    callback(null, chunk);
  }

  get sizeBytes(): number {
    return this.bytes;
  }

  /** Lower-case hex digest; call once, after the stream has ended. */
  digest(): string {
    return this.hash.digest('hex');
  }
}
