import {
  RevisionFailureCodeSchema,
  type CadMapping,
  type CadMappingView,
  type DesignRevisionDetail,
  type DesignRevisionSummary,
} from '@ftth/shared';
import type { CadMappingRecord } from '../domain/cad-mapping.js';
import type { DesignRevision } from '../domain/design-revision.js';
import type { CadMappingViewModel } from '../application/cad-mapping.use-cases.js';

export function toRevisionSummaryDto(revision: DesignRevision): DesignRevisionSummary {
  const failure = RevisionFailureCodeSchema.safeParse(revision.errorCode);
  return {
    id: revision.id,
    projectId: revision.projectId,
    cadFileId: revision.cadFileId,
    cadFileName: revision.cadFileName,
    revNo: revision.revNo,
    status: revision.status,
    crsEpsg: revision.crsEpsg,
    drawingUnit: revision.drawingUnit,
    metresPerUnit: revision.metresPerUnit,
    insUnits: revision.insUnits,
    unitsConflict: revision.unitsConflict,
    baseRevisionId: revision.baseRevisionId,
    counts: revision.counts,
    textLinkCounts: revision.textLinkCounts,
    diffCounts: revision.diffCounts,
    hasTiles: revision.tilesStorageKey !== null,
    // A failed row always has a code; an unknown one (newer worker) is reported as INTERNAL.
    errorCode: revision.errorCode === null ? null : failure.success ? failure.data : 'INTERNAL',
    createdById: revision.createdById,
    createdAt: revision.createdAt.toISOString(),
    builtAt: revision.builtAt?.toISOString() ?? null,
    publishedAt: revision.publishedAt?.toISOString() ?? null,
    publishedById: revision.publishedById,
  };
}

export function toRevisionDetailDto(revision: DesignRevision): DesignRevisionDetail {
  return {
    ...toRevisionSummaryDto(revision),
    rules: revision.rules,
    errorMessage: revision.errorMessage,
    log: revision.log,
  };
}

export function toMappingDto(mapping: CadMappingRecord): CadMapping {
  return {
    cadFileId: mapping.cadFileId,
    rules: mapping.rules,
    crsEpsg: mapping.crsEpsg,
    drawingUnit: mapping.drawingUnit,
    metresPerUnit: mapping.metresPerUnit,
    version: mapping.version,
    updatedById: mapping.updatedById,
    updatedAt: mapping.updatedAt.toISOString(),
  };
}

export function toMappingViewDto(view: CadMappingViewModel): CadMappingView {
  return {
    cadFileId: view.file.id,
    fileStatus: view.file.status,
    projectEpsg: view.projectEpsg,
    insUnits: view.file.insUnits,
    crsDetection: view.file.crsDetection,
    layers: view.layers,
    blocks: view.blocks,
    texts: view.texts,
    mapping: view.mapping ? toMappingDto(view.mapping) : null,
  };
}
