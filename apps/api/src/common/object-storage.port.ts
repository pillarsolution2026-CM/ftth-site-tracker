import type { Readable } from 'node:stream';

/**
 * Port for file storage (ADR-012). Adapters: `fs` (directory shared with the CAD worker) and `s3`.
 * Selected by STORAGE_DRIVER. Keys are relative, '/'-separated and validated by `isValidStorageKey`.
 */
export interface StoredObject {
  sizeBytes: number;
  /** Lower-case hex SHA-256 of the bytes written, computed while streaming. */
  sha256: string;
}

/** Inclusive byte range, as in `Content-Range: bytes start-end/size`. */
export interface ByteRange {
  start: number;
  end: number;
}

export interface PutOptions {
  contentType: string;
  /** Abort and clean up once more bytes than this arrive → AppError FILE_TOO_LARGE. */
  maxBytes: number;
}

export interface ObjectStorage {
  /**
   * Streams `body` to `key`. Write-once: fails with AppError CONFLICT if the key exists
   * (fs: temp file + link/rename without overwrite; s3: `If-None-Match: *`). Never leaves a
   * partial object at `key`.
   */
  put(key: string, body: Readable, options: PutOptions): Promise<StoredObject>;
  /**
   * Throws AppError NOT_FOUND if absent. With `range` only those bytes are streamed (inclusive
   * `start`/`end`, already validated against the object size by the caller).
   */
  get(key: string, range?: ByteRange): Promise<Readable>;
  /** null if absent. */
  stat(key: string): Promise<{ sizeBytes: number } | null>;
  /** Idempotent: deleting a missing key succeeds. */
  delete(key: string): Promise<void>;
}

export const OBJECT_STORAGE = 'OBJECT_STORAGE';

const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;

/** Rejects absolute paths, `..`, empty segments and anything outside [a-z0-9._-/]. */
export function isValidStorageKey(key: string): boolean {
  return key.length <= 512 && KEY_PATTERN.test(key) && !key.split('/').includes('..');
}

/** Canonical keys. Original file names are kept in the DB only, never in keys. */
export const storageKeys = {
  cadOriginal: (projectId: string, cadFileId: string, format: 'dwg' | 'dxf') =>
    `projects/${projectId}/cad/${cadFileId}/original.${format}`,
  cadConverted: (projectId: string, cadFileId: string) =>
    `projects/${projectId}/cad/${cadFileId}/converted.dxf`,
  /** Contracts sit above projects (ADR-027), so their files are not under a project prefix. */
  contractAttachment: (contractId: string, attachmentId: string, ext: 'pdf' | 'xlsx') =>
    `contracts/${contractId}/attachments/${attachmentId}.${ext}`,
  workOrderAttachment: (
    projectId: string,
    workOrderId: string,
    attachmentId: string,
    ext: 'pdf' | 'xlsx',
  ) => `projects/${projectId}/work-orders/${workOrderId}/attachments/${attachmentId}.${ext}`,
} as const;
