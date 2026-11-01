import type {
  AsBuiltEdit,
  ErrorCode,
  ExecutionUpdate,
  OpRejectionCode,
  PhotoUploadStatus,
  SyncChangesResponse,
  SyncOp,
  SyncPushRequest,
  SyncPushResponse,
} from '@ftth/shared';

/** Why an outbox entry stopped for good: a server rejection, or a payload the server refused. */
export type EntryRejection = OpRejectionCode | 'VALIDATION_FAILED';

export type OutboxState = 'pending' | 'applied' | 'rejected';

export interface OutboxEntry {
  clientOpId: string;
  op: SyncOp;
  state: OutboxState;
  /** Push attempts that ended without a result (network loss, server error). */
  attempts: number;
  updateId: string | null;
  rejection: EntryRejection | null;
}

export type PhotoState = 'waiting' | 'stored' | 'failed';

export interface PendingPhoto {
  photoId: string;
  clientOpId: string;
  sizeBytes: number;
  /** Bytes the server confirmed; a hint only — the server's status wins. */
  uploadedBytes: number;
  state: PhotoState;
  /** Complete uploads the server refused (sha256 or JPEG check). */
  checksumFailures: number;
}

/**
 * Device-side persistence of the outbox (WatermelonDB on the phone, in memory in tests). Every
 * method must be durable when it resolves: the app may be killed at any point.
 */
export interface SyncStore {
  /** Entries in state `pending`, oldest first. */
  pendingOps(limit: number): Promise<OutboxEntry[]>;
  markApplied(clientOpId: string, updateId: string): Promise<void>;
  markRejected(clientOpId: string, rejection: EntryRejection): Promise<void>;
  markAttemptFailed(clientOpIds: readonly string[]): Promise<void>;
  /** Photos of applied entries that are neither stored nor failed. */
  photosToUpload(): Promise<PendingPhoto[]>;
  setPhotoProgress(
    photoId: string,
    progress: { uploadedBytes: number; state: PhotoState; checksumFailures: number },
  ): Promise<void>;
  getCursor(): Promise<string>;
  setCursor(cursor: string): Promise<void>;
  /** Server truth about updates in the user's scope (status, flags, review reason). */
  applyRemoteUpdates(updates: readonly ExecutionUpdate[]): Promise<void>;
  /** Server truth about As-Built edits in the user's scope (status, approved version; ADR-030). */
  applyRemoteAsBuiltEdits(edits: readonly AsBuiltEdit[]): Promise<void>;
}

/** Bytes of a compressed, watermarked photo kept on the device until the server stores it. */
export interface PhotoSource {
  read(photoId: string): Promise<Uint8Array>;
}

export interface SyncTransport {
  push(request: SyncPushRequest): Promise<SyncPushResponse>;
  changes(cursor: string, limit: number): Promise<SyncChangesResponse>;
  photoStatus(photoId: string): Promise<PhotoUploadStatus>;
  putPhotoChunk(photoId: string, offset: number, bytes: Uint8Array): Promise<PhotoUploadStatus>;
}

/** `network`: no response at all (offline, timeout, connection reset). */
export class TransportError extends Error {
  constructor(
    readonly kind: 'network' | 'http',
    readonly status: number | null = null,
    readonly code: ErrorCode | null = null,
    readonly details: unknown = undefined,
    message = kind === 'network' ? 'Network unavailable' : `HTTP ${status ?? '?'}`,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}
