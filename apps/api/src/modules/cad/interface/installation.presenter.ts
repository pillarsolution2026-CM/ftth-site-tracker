import {
  installationQuestionApplies,
  metresToMm,
  mmToMetres,
  type InstallationAnswerRecord,
  type InstallationState,
  type TrenchMark,
} from '@ftth/shared';
import type { InstallationStateModel } from '../application/installation.use-cases.js';
import type { InstallationAnswerRow, TrenchMarkRecord } from '../domain/installation.js';

export function toAnswerDto(row: InstallationAnswerRow): InstallationAnswerRecord {
  return {
    id: row.id,
    cadFileId: row.cadFileId,
    answer: row.answer,
    answeredBy: row.createdBy,
    answeredAt: row.createdAt.toISOString(),
  };
}

export function toTrenchMarkDto(record: TrenchMarkRecord): TrenchMark {
  return {
    id: record.id,
    cadFileId: record.cadFileId,
    routeHandle: record.routeHandle,
    lengthM: record.lengthM,
    createdBy: record.createdBy,
    createdAt: record.createdAt.toISOString(),
    withdrawnBy: record.withdrawnBy,
    withdrawnAt: record.withdrawnAt ? record.withdrawnAt.toISOString() : null,
  };
}

export function toInstallationStateDto(model: InstallationStateModel): InstallationState {
  const active = model.marks.filter((mark) => mark.withdrawnAt === null);
  const trenchMm = active.reduce((sum, mark) => sum + metresToMm(mark.lengthM), 0n);
  const answers = model.answers.map(toAnswerDto);
  return {
    cadFileId: model.file.id,
    drawingKind: model.file.drawingKind,
    asked: installationQuestionApplies(model.file.drawingKind),
    answer: answers[0] ?? null,
    answerHistory: answers,
    marks: model.marks.map(toTrenchMarkDto),
    activeMarkCount: active.length,
    activeTrenchM: mmToMetres(trenchMm),
  };
}
