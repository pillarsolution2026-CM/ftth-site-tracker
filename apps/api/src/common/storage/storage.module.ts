import { Global, Module } from '@nestjs/common';
import type { ApiEnv } from '@ftth/shared';
import { APP_ENV } from '../../config/config.module.js';
import { OBJECT_STORAGE, type ObjectStorage } from '../object-storage.port.js';
import { FsObjectStorage } from './fs-object-storage.js';

/** Picks the adapter from STORAGE_DRIVER. The S3 SDK is only loaded when it is selected. */
export async function createObjectStorage(env: ApiEnv): Promise<ObjectStorage> {
  if (env.STORAGE_DRIVER === 'fs') return new FsObjectStorage(env.STORAGE_FS_ROOT);

  const { S3ObjectStorage, createS3Client } = await import('./s3-object-storage.js');
  // ApiEnvSchema guarantees these four for STORAGE_DRIVER=s3.
  const endpoint = env.S3_ENDPOINT ?? '';
  const bucket = env.S3_BUCKET ?? '';
  const accessKey = env.S3_ACCESS_KEY ?? '';
  const secretKey = env.S3_SECRET_KEY ?? '';
  const client = createS3Client({ endpoint, bucket, accessKey, secretKey, region: env.S3_REGION });
  return new S3ObjectStorage(client, bucket);
}

@Global()
@Module({
  providers: [{ provide: OBJECT_STORAGE, inject: [APP_ENV], useFactory: createObjectStorage }],
  exports: [OBJECT_STORAGE],
})
export class StorageModule {}
