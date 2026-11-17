import {
  InstallationAnswerRecordSchema,
  InstallationStateSchema,
  TrenchMarkSchema,
  type CreateTrenchMarkRequest,
  type InstallationAnswerRecord,
  type InstallationState,
  type SetInstallationAnswerRequest,
  type TrenchMark,
} from '@ftth/shared';
import { bffJson, projectApiPath } from '@/shared/api/bff-client';

const filePath = (projectId: string, cadFileId: string) =>
  projectApiPath(projectId, `/cad-files/${encodeURIComponent(cadFileId)}/installation`);

/** The live answer and trench marks of a CAD file (ADR-042 part D). */
export function getInstallation(projectId: string, cadFileId: string): Promise<InstallationState> {
  return bffJson(filePath(projectId, cadFileId), InstallationStateSchema);
}

export function setInstallationAnswer(
  projectId: string,
  cadFileId: string,
  body: SetInstallationAnswerRequest,
): Promise<InstallationAnswerRecord> {
  return bffJson(`${filePath(projectId, cadFileId)}/answer`, InstallationAnswerRecordSchema, {
    method: 'PUT',
    body,
  });
}

export function createTrenchMark(
  projectId: string,
  cadFileId: string,
  body: CreateTrenchMarkRequest,
): Promise<TrenchMark> {
  return bffJson(`${filePath(projectId, cadFileId)}/trench-marks`, TrenchMarkSchema, {
    method: 'POST',
    body,
  });
}

export function withdrawTrenchMark(
  projectId: string,
  cadFileId: string,
  markId: string,
): Promise<TrenchMark> {
  return bffJson(
    `${filePath(projectId, cadFileId)}/trench-marks/${encodeURIComponent(markId)}/withdraw`,
    TrenchMarkSchema,
    { method: 'POST' },
  );
}
