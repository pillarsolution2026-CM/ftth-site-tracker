import {
  CAD_STALE_AFTER_MINUTES,
  type CadExtents,
  type CadFileCounts,
  type CadFileStatus,
  type CadFormat,
  type CadWarning,
  type CrsDetection,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';

/** Raw CAD upload and its processing state (ADR-013). Originals are immutable. */
export interface CadFile {
  id: string;
  projectId: string;
  originalName: string;
  format: CadFormat;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
  convertedStorageKey: string | null;
  status: CadFileStatus;
  /** The only job allowed to change this row; a newer reprocess supersedes older jobs. */
  currentJobId: string | null;
  converter: 'oda' | 'libredwg' | 'none' | null;
  converterVersion: string | null;
  dxfVersion: string | null;
  insUnits: number | null;
  extents: CadExtents | null;
  /** CRS suggested by the worker from the extents; null for files processed before Phase 1b. */
  crsDetection: CrsDetection | null;
  counts: CadFileCounts | null;
  warnings: CadWarning[];
  errorCode: string | null;
  errorMessage: string | null;
  uploadedById: string | null;
  createdAt: Date;
  updatedAt: Date;
  queuedAt: Date | null;
  processingStartedAt: Date | null;
  processedAt: Date | null;
}

/** A file stuck in queued/processing for longer than CAD_STALE_AFTER_MINUTES may be reprocessed. */
export function isStale(file: CadFile, now: Date): boolean {
  const since =
    file.status === 'processing' ? (file.processingStartedAt ?? file.queuedAt) : file.queuedAt;
  if (!since) return true;
  return now.getTime() - since.getTime() > CAD_STALE_AFTER_MINUTES * 60_000;
}

/** Reprocessing is refused while a recent job may still be running. */
export function assertCanReprocess(file: CadFile, now: Date): void {
  const running = file.status === 'queued' || file.status === 'processing';
  if (running && !isStale(file, now)) {
    throw new AppError('CONFLICT', 'The file is already being processed', {
      reason: 'ALREADY_RUNNING',
      status: file.status,
    });
  }
}
