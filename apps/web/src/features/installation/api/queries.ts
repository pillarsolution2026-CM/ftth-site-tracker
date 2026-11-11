import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateTrenchMarkRequest, SetInstallationAnswerRequest } from '@ftth/shared';
import {
  createTrenchMark,
  getInstallation,
  setInstallationAnswer,
  withdrawTrenchMark,
} from './installation-api';

export const installationKey = (projectId: string, cadFileId: string) =>
  ['installation', projectId, cadFileId] as const;

/** Live answer and marks of a file; `enabled` should be false for a Secondary. */
export function useInstallation(projectId: string, cadFileId: string, enabled: boolean) {
  return useQuery({
    enabled,
    retry: false,
    queryKey: installationKey(projectId, cadFileId),
    queryFn: () => getInstallation(projectId, cadFileId),
  });
}

function useRefresh(projectId: string, cadFileId: string) {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: installationKey(projectId, cadFileId) });
}

export function useSetInstallationAnswer(projectId: string, cadFileId: string) {
  const refresh = useRefresh(projectId, cadFileId);
  return useMutation({
    mutationFn: (body: SetInstallationAnswerRequest) =>
      setInstallationAnswer(projectId, cadFileId, body),
    onSuccess: refresh,
  });
}

export function useCreateTrenchMark(projectId: string, cadFileId: string) {
  const refresh = useRefresh(projectId, cadFileId);
  return useMutation({
    mutationFn: (body: CreateTrenchMarkRequest) => createTrenchMark(projectId, cadFileId, body),
    onSuccess: refresh,
  });
}

export function useWithdrawTrenchMark(projectId: string, cadFileId: string) {
  const refresh = useRefresh(projectId, cadFileId);
  return useMutation({
    mutationFn: (markId: string) => withdrawTrenchMark(projectId, cadFileId, markId),
    onSuccess: refresh,
  });
}
