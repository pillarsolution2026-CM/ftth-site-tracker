import { CadFailureCodeSchema, type CadFileDetail, type CadFileSummary } from '@ftth/shared';
import type { CadFile } from '../domain/cad-file.js';

export function toSummaryDto(file: CadFile): CadFileSummary {
  const failure = CadFailureCodeSchema.safeParse(file.errorCode);
  return {
    id: file.id,
    projectId: file.projectId,
    originalName: file.originalName,
    format: file.format,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
    status: file.status,
    uploadedById: file.uploadedById,
    // Counts of an earlier run stay in the row while a reprocess is in flight; only show final ones.
    counts: file.status === 'processed' ? file.counts : null,
    warningCount: file.warnings.length,
    // A failed row always has a code; an unknown one (newer worker) is reported as INTERNAL.
    errorCode: file.errorCode === null ? null : failure.success ? failure.data : 'INTERNAL',
    createdAt: file.createdAt.toISOString(),
    updatedAt: file.updatedAt.toISOString(),
    processedAt: file.processedAt?.toISOString() ?? null,
  };
}

export function toDetailDto(file: CadFile): CadFileDetail {
  return {
    ...toSummaryDto(file),
    dxfVersion: file.dxfVersion,
    converter: file.converter,
    converterVersion: file.converterVersion,
    insUnits: file.insUnits,
    extents: file.extents,
    crsDetection: file.crsDetection,
    warnings: file.warnings,
    errorMessage: file.errorMessage,
    queuedAt: file.queuedAt?.toISOString() ?? null,
    processingStartedAt: file.processingStartedAt?.toISOString() ?? null,
  };
}
