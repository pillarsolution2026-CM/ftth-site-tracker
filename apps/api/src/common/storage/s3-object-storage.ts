import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '../app-error.js';
import {
  isValidStorageKey,
  type ObjectStorage,
  type PutOptions,
  type StoredObject,
} from '../object-storage.port.js';
import { UploadMeter } from './upload-meter.js';

export interface S3StorageSettings {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
}

export function createS3Client(settings: S3StorageSettings): S3Client {
  return new S3Client({
    endpoint: settings.endpoint,
    region: settings.region,
    credentials: { accessKeyId: settings.accessKey, secretAccessKey: settings.secretKey },
    forcePathStyle: true, // MinIO and Hetzner Object Storage
  });
}

/** `s3` adapter (Hetzner Object Storage / MinIO). Streams uploads; never buffers a whole file. */
export class S3ObjectStorage implements ObjectStorage {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async put(key: string, body: Readable, options: PutOptions): Promise<StoredObject> {
    this.assertKey(key);
    if ((await this.stat(key)) !== null)
      throw new AppError('CONFLICT', 'Storage key already exists');

    const meter = new UploadMeter(options.maxBytes);
    const pass = new PassThrough();
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: pass,
        ContentType: options.contentType,
        IfNoneMatch: '*', // write-once even if two requests race past the stat above
      },
    });
    const uploading = upload.done();
    // Avoid an unhandled rejection if the metering pipeline fails first.
    uploading.catch(() => undefined);
    try {
      await pipeline(body, meter, pass);
      await uploading;
    } catch (error) {
      await upload.abort().catch(() => undefined);
      throw isPreconditionFailed(error)
        ? new AppError('CONFLICT', 'Storage key already exists')
        : error;
    }
    return { sizeBytes: meter.sizeBytes, sha256: meter.digest() };
  }

  async get(key: string): Promise<Readable> {
    this.assertKey(key);
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!(response.Body instanceof Readable)) throw new AppError('NOT_FOUND', 'File not found');
      return response.Body;
    } catch (error) {
      if (isNotFound(error)) throw new AppError('NOT_FOUND', 'File not found');
      throw error;
    }
  }

  async stat(key: string): Promise<{ sizeBytes: number } | null> {
    this.assertKey(key);
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { sizeBytes: head.ContentLength ?? 0 };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    this.assertKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  private assertKey(key: string): void {
    if (!isValidStorageKey(key)) throw new AppError('VALIDATION_FAILED', 'Invalid storage key');
  }
}

function httpStatusOf(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
}
const isNotFound = (error: unknown): boolean =>
  httpStatusOf(error) === 404 || (error as { name?: string } | null)?.name === 'NoSuchKey';
const isPreconditionFailed = (error: unknown): boolean => httpStatusOf(error) === 412;
