import type { DrawingCorrection } from '@ftth/shared';
import type { DrawingCorrectionRecord } from '../domain/drawing-correction.js';

export function toDrawingCorrectionDto(record: DrawingCorrectionRecord): DrawingCorrection {
  return {
    id: record.id,
    cadFileId: record.cadFileId,
    correction: record.correction,
    problem: record.problem,
    createdBy: record.createdBy,
    createdAt: record.createdAt.toISOString(),
    withdrawnBy: record.withdrawnBy,
    withdrawnAt: record.withdrawnAt ? record.withdrawnAt.toISOString() : null,
  };
}
